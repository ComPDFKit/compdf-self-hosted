import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BatchService } from './batch.service';

@Injectable()
export class BatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BatchWorker.name);
  private readonly workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private active = 0;
  private polling = false;
  private stopped = false;
  private readonly pollMs = Math.max(250, Number(process.env.BATCH_WORKER_POLL_MS ?? 1000));

  constructor(private readonly batches: BatchService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      // One file at a time across all batches handled by this Server instance.
      // Do not claim another item until processing and result persistence settle.
      while (!this.stopped && this.active === 0) {
        let item;
        try {
          item = await this.batches.claimNext(this.workerId);
        } catch (err) {
          this.logger.warn(`batch worker poll failed: ${(err as Error).message}`);
          return;
        }
        if (!item) return;
        this.active += 1;
        void this.batches.process(item).catch((err) => this.logger.error(`batch item crashed: ${(err as Error).message}`)).finally(() => {
          this.active -= 1;
          void this.poll();
        });
      }
    } finally {
      this.polling = false;
    }
  }
}
