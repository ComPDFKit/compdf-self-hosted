/**
 * LoggingInterceptor — writes every HTTP request to `operation_logs`
 * (schema: configs/init.sql). Captures method/endpoint/feature/status_code/
 * duration_ms; errors are level=ERROR with stack.
 *
 * log_type mapping (architecture §7.2):
 *   - 2xx/3xx  → 'api_call', level INFO, result success
 *   - 4xx/5xx  → 'error',    level ERROR, result fail  (message + stack)
 * 'user_action' / 'system' are written by explicit callers, not here.
 *
 * Logging is best-effort: a DB write failure is swallowed (console-warned) and
 * NEVER propagates to the caller — a logging outage must not break PDF ops.
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MysqlClient } from '../../clients/mysql.client';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  constructor(private readonly db: MysqlClient) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const startedAt = Date.now();
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    return next.handle().pipe(
      tap({
        next: () => {
          const status = res.statusCode ?? 200;
          this.record(req, status, Date.now() - startedAt, null).catch((e) =>
            this.logger.warn(`log write failed: ${(e as Error).message}`),
          );
        },
        // Errors thrown downstream surface here as the observable error; we log
        // then re-throw (the AllExceptionsFilter shapes the response).
        error: (err: unknown) => {
          const status = errStatusOf(err);
          this.record(req, status, Date.now() - startedAt, err).catch((e) =>
            this.logger.warn(`log write failed: ${(e as Error).message}`),
          );
        },
      }),
    );
  }

  private async record(
    req: Record<string, any>,
    status: number,
    durationMs: number,
    err: unknown,
  ): Promise<void> {
    const isError = status >= 400 || err !== null;
    const logType = isError ? 'error' : 'api_call';
    const level: LogLevel = status >= 500 ? 'ERROR' : status >= 400 ? 'ERROR' : 'INFO';
    const operator = req.user?.username ?? null;
    const method = req.method ?? null;
    const endpoint = req.url ?? null;
    const feature = featureOf(endpoint);
    const fileInfo = uploadedFilename(req);
    const message = err instanceof Error ? err.message : null;
    const stack = err instanceof Error ? err.stack : null;

    await this.db.execute(
      `INSERT INTO operation_logs
         (log_type, operator, method, endpoint, feature, file_info, status_code, level, result, duration_ms, message, stack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        logType,
        operator,
        method,
        endpoint,
        feature,
        fileInfo,
        status,
        level,
        isError ? 'fail' : 'success',
        durationMs,
        message,
        stack,
      ],
    );
  }
}

/** Derive a short feature tag from the URL, e.g. `/api/v1/pdf/merge` → `pdf/merge`. */
function featureOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  const m = endpoint.match(/^\/api\/v1\/([^?]+)/);
  return m ? m[1] : null;
}

/** Pull the uploaded file's original name off a multer-populated request, if any. */
function uploadedFilename(req: Record<string, any>): string | null {
  const f = req.file ?? req.files?.[0];
  return f?.originalname ?? null;
}

function errStatusOf(err: unknown): number {
  if (err && typeof err === 'object') {
    const e = err as { getStatus?: () => number; status?: number };
    if (typeof e.getStatus === 'function') return e.getStatus();
    if (typeof e.status === 'number') return e.status;
  }
  return 500;
}
