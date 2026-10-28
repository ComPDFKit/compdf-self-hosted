import { describe, expect, it, vi } from 'vitest';
import { MysqlClient } from '../clients/mysql.client';
import { TaskDrainService } from './task-drain.service';

describe('TaskDrainService', () => {
  it('waits for synchronous requests even when the task tables are empty', async () => {
    const mysql = { query: vi.fn().mockResolvedValue([{ pending: 0, processing: 0 }]) } as unknown as MysqlClient;
    const runtime = { getActiveProcessingRequests: () => 1 };
    expect(await new TaskDrainService(mysql, runtime as never).getSnapshot()).toMatchObject({ active: 1, drained: false });
  });
  it('reports pending and processing tasks', async () => {
    const mysql = { query: vi.fn().mockResolvedValue([{ pending: '2', processing: 3 }]) } as unknown as MysqlClient;
    const snapshot = await new TaskDrainService(mysql).getSnapshot();
    expect(snapshot).toMatchObject({ pending: 2, processing: 3, active: 5, drained: false });
  });

  it('returns immediately after tasks drain', async () => {
    const mysql = {
      query: vi.fn()
        .mockResolvedValueOnce([{ pending: 1, processing: 0 }])
        .mockResolvedValueOnce([{ pending: 0, processing: 0 }]),
    } as unknown as MysqlClient;
    const result = await new TaskDrainService(mysql).waitForDrain({ timeoutMs: 100, pollIntervalMs: 1 });
    expect(result).toMatchObject({ drained: true, timedOut: false, canceled: false });
  });

  it('times out without forcing active tasks', async () => {
    const mysql = { query: vi.fn().mockResolvedValue([{ pending: 1, processing: 1 }]) } as unknown as MysqlClient;
    const result = await new TaskDrainService(mysql).waitForDrain({ timeoutMs: 0 });
    expect(result).toMatchObject({ drained: false, timedOut: true, canceled: false });
  });
});
