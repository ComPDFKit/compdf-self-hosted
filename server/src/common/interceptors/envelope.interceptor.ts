/**
 * EnvelopeInterceptor — wraps every JSON success response in the project's
 * standard envelope `{ code: 200, msg: 'success', data }`.
 *
 * Sync file-download endpoints (pdf/*, conversion/*, process/*, task/:id/download,
 * dashboard/logs/export, dashboard/branding/logo) write directly to `res` via
 * `@Res()` and call `res.send()` before returning. By the time this interceptor's
 * `map` runs, `res.headersSent` is true for those — we pass the data through
 * untouched so the binary bytes (not an envelope) go to the client. For handlers
 * that `return` a value, `headersSent` is false and we wrap.
 *
 * Registered AFTER License + Logging (innermost), so it wraps the controller
 * return value; LoggingInterceptor only reads `res.statusCode` (tap, not map),
 * so the envelope does not affect operation_logs. Successful JSON responses
 * always use business code 200 in the body, even when the HTTP status is 202.
 *
 * Errors never reach this interceptor — they throw to AllExceptionsFilter, which
 * produces the matching error envelope `{ code, msg, data: null, ... }`.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';

export interface Envelope<T = unknown> {
  /** Business success code. */
  code: 200;
  msg: 'success';
  data: T;
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data) => {
        const res = context.switchToHttp().getResponse();
        // @Res()-based stream handlers have already sent the response; don't
        // double-write (would throw "Cannot set headers after they are sent").
        if (res?.headersSent) return data;
        return { code: 200, msg: 'success', data } satisfies Envelope;
      }),
    );
  }
}
