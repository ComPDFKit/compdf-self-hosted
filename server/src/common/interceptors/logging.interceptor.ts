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
 * result_category (PRD §5 stat分类):
 *   - success   = 2xx
 *   - invalid   = 4xx local HttpException (validation/auth/bad-request)
 *   - fail      = 4xx UpstreamSdkError (SDK business failure, e.g. wrong password)
 *   - exception = 5xx (server/upstream crash, incl. upstream 5xx → 502)
 * duration_ms is recorded ONLY for success (PRD: "只需要记录成功的时间").
 *
 * Logging is best-effort: a DB write failure is swallowed (console-warned) and
 * NEVER propagates to the caller — a logging outage must not break PDF ops.
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MysqlClient } from '../../clients/mysql.client';
import { UpstreamSdkError } from '../errors/upstream-sdk.error';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
type ResultCategory = 'success' | 'invalid' | 'fail' | 'exception';

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
    const category = categorize(status, err);
    const operator = req.user?.username ?? null;
    // PRD §5: api_call logs record the API key. ApiKeyGuard stamps req.apiKeyId.
    const apiKeyId = req.apiKeyId ?? null;
    const method = req.method ?? null;
    const endpoint = req.url ?? null;
    const feature = featureOf(endpoint);
    const fileInfo = uploadedFilename(req);
    const message = err instanceof Error ? err.message : null;
    const stack = err instanceof Error ? err.stack : null;
    // PRD: only record duration for successful requests.
    const recordedDuration = category === 'success' ? durationMs : null;

    await this.db.execute(
      `INSERT INTO operation_logs
         (log_type, operator, api_key_id, method, endpoint, feature, file_info, status_code, level, result, result_category, duration_ms, message, stack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        logType,
        operator,
        apiKeyId,
        method,
        endpoint,
        feature,
        fileInfo,
        status,
        level,
        isError ? 'fail' : 'success',
        category,
        recordedDuration,
        message,
        stack,
      ],
    );
  }
}

/**
 * Derive the stat category from status + error source.
 *   success   < 400, no error
 *   exception >= 500 (server crash or upstream 5xx mapped to 502)
 *   fail      4xx from UpstreamSdkError (SDK business failure)
 *   invalid   4xx from local HttpException (validation/auth/bad-request)
 */
function categorize(status: number, err: unknown | null): ResultCategory {
  if (status < 400 && !err) return 'success';
  if (status >= 500) return 'exception';
  if (err instanceof UpstreamSdkError) return 'fail';
  return 'invalid';
}

/** Derive a short feature tag from the URL, e.g. `/api/v1/process/pdf/merge` → `process/pdf/merge`. */
function featureOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  const m = endpoint.match(/^\/api\/v1\/([^?]+)/);
  return m ? m[1] : null;
}

/**
 * Pull uploaded file name(s) off a multer-populated request. Handles all three
 * multer shapes: FileInterceptor (req.file), FilesInterceptor (req.files[]),
 * FileFieldsInterceptor (req.files { field: MulterFile[] }). Multiple names
 * are joined; capped at 255 chars (file_info column width).
 */
function uploadedFilename(req: Record<string, any>): string | null {
  const collect = (f: any): string | null => (f && typeof f === 'object' && f.originalname) ? String(f.originalname) : null;
  let names: string[] = [];
  if (req.file) {
    const n = collect(req.file);
    if (n) names.push(n);
  }
  const files = req.files;
  if (Array.isArray(files)) {
    for (const f of files) {
      const n = collect(f);
      if (n) names.push(n);
    }
  } else if (files && typeof files === 'object') {
    for (const arr of Object.values(files)) {
      if (Array.isArray(arr)) {
        for (const f of arr) {
          const n = collect(f);
          if (n) names.push(n);
        }
      }
    }
  }
  if (names.length === 0) return null;
  const joined = names.join(', ');
  return joined.length > 255 ? `${joined.slice(0, 252)}...` : joined;
}

function errStatusOf(err: unknown): number {
  if (err && typeof err === 'object') {
    const e = err as { getStatus?: () => number; status?: number };
    if (typeof e.getStatus === 'function') return e.getStatus();
    if (typeof e.status === 'number') return e.status;
  }
  return 500;
}
