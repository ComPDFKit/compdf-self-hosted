import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchWorker } from './batch.worker';

afterEach(() => { vi.unstubAllEnvs(); });

describe('serial batch worker', () => {
  it.each(['success', 'failure'])('waits for the current file before starting another batch after %s', async (outcome) => {
    // A legacy deployment setting must not re-enable parallel submissions.
    vi.stubEnv('BATCH_WORKER_CONCURRENCY', '8');
    let finish!: () => void;
    let fail!: (err: Error) => void;
    const pending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const first = { item_id: 'first', batch_id: 'batch-a' };
    const second = { item_id: 'second', batch_id: 'batch-b' };
    const batches = {
      claimNext: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValue(null),
      process: vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(undefined),
    };
    const worker = new BatchWorker(batches as any);
    try {
      await (worker as any).poll();
      await Promise.all(Array.from({ length: 8 }, () => (worker as any).poll()));
      expect(batches.claimNext).toHaveBeenCalledTimes(1);
      expect(batches.process.mock.calls).toEqual([[first]]);
      if (outcome === 'success') finish();
      else fail(new Error('upstream request failed'));
      await vi.waitFor(() => expect(batches.process.mock.calls).toEqual([[first], [second]]));
    } finally {
      worker.onModuleDestroy();
      finish();
    }
  });

  it('does not submit another file after shutdown while a file is in flight', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const batches = {
      claimNext: vi.fn().mockResolvedValue({ item_id: 'first' }),
      process: vi.fn().mockReturnValue(pending),
    };
    const worker = new BatchWorker(batches as any);
    await (worker as any).poll();
    worker.onModuleDestroy();
    finish();
    await vi.waitFor(() => expect((worker as any).active).toBe(0));
    expect(batches.claimNext).toHaveBeenCalledTimes(1);
  });
});
