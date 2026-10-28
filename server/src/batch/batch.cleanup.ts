import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BatchService } from './batch.service';

@Injectable()
export class BatchCleanup implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BatchCleanup.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly batches: BatchService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.run(), 24 * 60 * 60 * 1000);
    this.timer.unref();
    void this.run();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    try {
      const removed = await this.batches.cleanupExpired();
      if (removed > 0) this.logger.log(`removed ${removed} expired batch(es)`);
    } catch (err) {
      this.logger.warn(`batch cleanup failed: ${(err as Error).message}`);
    }
  }
}
