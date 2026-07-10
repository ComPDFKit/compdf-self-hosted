/**
 * SystemLogService — writes 'system' rows to operation_logs at server startup
 * and shutdown (PRD §5: service start/stop → system log), and 'error' rows for
 * non-API failures (system-level faults, client-reported UI errors). Best-effort:
 * a DB failure is swallowed so it never blocks boot or a request. Also exposes
 * `record()` for ad-hoc system events.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MysqlClient } from '../clients/mysql.client';

type ErrorCategory = 'invalid' | 'fail' | 'exception';

@Injectable()
export class SystemLogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemLogService.name);

  constructor(private readonly mysql: MysqlClient) {}

  async onModuleInit(): Promise<void> {
    await this.record('service_started', 'ComPDF server started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.record('service_stopped', 'ComPDF server stopped');
  }

  /** Best-effort system log. Never throws. */
  async record(action: string, detail: string, target: string | null = null): Promise<void> {
    await this.mysql
      .execute(
        `INSERT INTO operation_logs (log_type, operator, level, result, result_category, action, target, message)
         VALUES ('system', 'system', 'INFO', 'success', 'success', ?, ?, ?)`,
        [action, target, `${detail}`.slice(0, 500)],
      )
      .catch((err: Error) => this.logger.warn(`system log write failed: ${err.message}`));
  }

  /**
   * Best-effort error log for NON-API failures (system-level faults, client UI
   * errors). method/endpoint are NULL (no HTTP request). category defaults to
   * 'exception' (system fault); client UI failures should pass 'fail'.
   */
  async recordError(
    action: string,
    message: string,
    opts: { stack?: string | null; target?: string | null; category?: ErrorCategory } = {},
  ): Promise<void> {
    const category = opts.category ?? 'exception';
    await this.mysql
      .execute(
        `INSERT INTO operation_logs (log_type, operator, level, result, result_category, action, target, message, stack)
         VALUES ('error', 'system', 'ERROR', 'fail', ?, ?, ?, ?, ?)`,
        [category, action, opts.target ?? null, `${message}`.slice(0, 1000), opts.stack ?? null],
      )
      .catch((err: Error) => this.logger.warn(`error log write failed: ${err.message}`));
  }
}
