import { Injectable } from '@nestjs/common';
import { MysqlClient } from '../clients/mysql.client';
import { RuntimeModeService } from './runtime-mode.service';

export interface TaskDrainSnapshot {
  pending: number;
  processing: number;
  active: number;
  drained: boolean;
  observedAt: string;
}

export interface WaitForDrainOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (snapshot: TaskDrainSnapshot) => void | Promise<void>;
}

@Injectable()
export class TaskDrainService {
  constructor(private readonly mysql: MysqlClient, private readonly runtimeMode?: RuntimeModeService) {}

  async getSnapshot(): Promise<TaskDrainSnapshot> {
    let rows: Array<{ pending: number | string | null; processing: number | string | null }>;
    try {
      rows = await this.mysql.query(
        `SELECT
           (SELECT COUNT(*) FROM tasks WHERE status = 'pending') +
           (SELECT COUNT(*) FROM batch_items WHERE status = 'queued') AS pending,
           (SELECT COUNT(*) FROM tasks WHERE status = 'processing') +
           (SELECT COUNT(*) FROM batch_items WHERE status = 'processing') AS processing`,
      );
    } catch {
      // Existing 4.1 installations may be between startup and the batch schema
      // migration. Keep the legacy drain signal usable until migration runs.
      rows = await this.mysql.query(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing
         FROM tasks`,
      );
    }
    const pending = toCount(rows[0]?.pending);
    const processing = toCount(rows[0]?.processing) + (this.runtimeMode?.getActiveProcessingRequests() ?? 0);
    return {
      pending,
      processing,
      active: pending + processing,
      drained: pending + processing === 0,
      observedAt: new Date().toISOString(),
    };
  }

  async waitForDrain(options: WaitForDrainOptions): Promise<TaskDrainSnapshot & { timedOut: boolean; canceled: boolean }> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error('timeoutMs must be non-negative');
    const interval = options.pollIntervalMs ?? 1000;
    if (!Number.isFinite(interval) || interval <= 0) throw new Error('pollIntervalMs must be positive');
    const deadline = Date.now() + options.timeoutMs;

    for (;;) {
      const snapshot = await this.getSnapshot();
      await options.onProgress?.(snapshot);
      if (snapshot.drained) return { ...snapshot, timedOut: false, canceled: false };
      if (options.signal?.aborted) return { ...snapshot, timedOut: false, canceled: true };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...snapshot, timedOut: true, canceled: false };
      await wait(Math.min(interval, remaining), options.signal);
    }
  }
}

function toCount(value: number | string | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => done();
    signal?.addEventListener('abort', onAbort, { once: true });
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}
