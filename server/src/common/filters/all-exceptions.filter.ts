/**
 * AllExceptionsFilter — single normalization point for ALL errors leaving the
 * server. Every error response uses the project's standard envelope shape:
 * `{ code, msg, data: null, [errorCode?, bizCode?, traceId?, details?] }`.
 *
 * `code` is ALWAYS the HTTP status code as a string (e.g. '400', '401', '502').
 * Business codes are carried in dedicated fields so clients can branch on them:
 *   - `errorCode` — string business code. For local HttpExceptions it's the
 *     thrown `{ code }` payload (e.g. 'TASK_NOT_READY', 'VALIDATION_ERROR');
 *     for conversion-engine upstream errors it's the upstream `errorCode`;
 *     for PDF SDK errors it is derived from the upstream numeric `code`.
 *   - `bizCode` — the upstream SDK's 6-digit numeric code (e.g. 110001, 100104),
 *     present only for upstream errors (both dialects).
 *
 * Handles BOTH upstream dialects (docs/sdk-contract.md §4, correction #4):
 *   PDF SDK errors:     { code, message, traceId }            — NO errorCode
 *   Conversion errors:  { code, errorCode, message, traceId } — HAS errorCode
 * Detection is by `errorCode` presence on UpstreamSdkError, NOT by code range
 * (ranges overlap by design).
 *
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { ErrorCode, semanticErrorCodeForBizCode } from '../errors/error-codes';
import { UpstreamSdkError } from '../errors/upstream-sdk.error';

export interface NormalizedError {
  statusCode: number;
  body: {
    /** HTTP status code as a string (e.g. '400', '502'). */
    code: string;
    msg: string;
    data: null;
    /** String business code (local thrown code or conversion-engine errorCode). */
    errorCode?: string;
    /** Upstream SDK 6-digit numeric code (upstream errors only). */
    bizCode?: number;
    traceId?: string;
    details?: unknown;
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const { statusCode, body } = AllExceptionsFilter.toResponse(exception);

    if (statusCode >= 500) {
      this.logger.error(`${body.code} ${body.errorCode ?? ''}: ${body.msg}`, exception instanceof Error ? exception.stack : undefined);
    }
    res.status(statusCode).json(body);
  }

  /** Pure normalization — unit-tested directly for both dialects. */
  static toResponse(exception: unknown): NormalizedError {
    if (exception instanceof UpstreamSdkError) {
      return AllExceptionsFilter.normalizeUpstream(exception);
    }
    if (exception instanceof HttpException) {
      return AllExceptionsFilter.normalizeHttp(exception);
    }
    // Unknown — never leak internals.
    return {
      statusCode: 500,
      body: {
        code: '500',
        msg: 'internal server error',
        data: null,
        errorCode: ErrorCode.INTERNAL_ERROR,
        details: process.env.NODE_ENV === 'development' && exception instanceof Error
          ? { name: exception.name }
          : undefined,
      },
    };
  }

  private static normalizeUpstream(err: UpstreamSdkError): NormalizedError {
    // Pass the client-facing HTTP status through (4xx
    // stays actionable), but surface upstream 5xx as 502 bad gateway.
    const statusCode = err.status >= 500 ? 502 : err.status >= 400 ? err.status : 502;
    const body: NormalizedError['body'] = {
      code: String(statusCode),
      msg: err.message,
      data: null,
      bizCode: err.code,
      traceId: err.traceId,
    };
    body.errorCode = err.errorCode
      ?? semanticErrorCodeForBizCode(err.code, err.isConversion ? 'conversion' : 'pdf')
      ?? ErrorCode.UPSTREAM_ERROR;
    return { statusCode, body };
  }

  private static normalizeHttp(err: HttpException): NormalizedError {
    const status = err.getStatus();
    const resp = err.getResponse();

    // ValidationPipe BadRequest: resp may be { message: ValidationError[], error, statusCode }
    if (status === 400 && Array.isArray((resp as any)?.message)) {
      const details = flattenValidation((resp as any).message);
      return {
        statusCode: 400,
        body: { code: '400', msg: 'validation failed', data: null, errorCode: ErrorCode.VALIDATION_ERROR, details },
      };
    }

    // Our own thrown HttpExceptions carry a { code, message } payload (e.g.
    // ConflictException({ code: 'TASK_NOT_READY', message })). `code` becomes the
    // HTTP status; the thrown business code moves to `errorCode`.
    if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
      const r = resp as Record<string, unknown>;
      const errorCode = typeof r.code === 'string' ? r.code : httpCodeFor(status);
      const msg = typeof r.message === 'string' ? r.message : err.message;
      return { statusCode: status, body: { code: String(status), msg, data: null, errorCode, details: r.details } };
    }

    return {
      statusCode: status,
      body: { code: String(status), msg: typeof resp === 'string' ? resp : err.message, data: null, errorCode: httpCodeFor(status) },
    };
  }
}

function httpCodeFor(status: number): string {
  switch (status) {
    case 400: return ErrorCode.BAD_REQUEST;
    case 401: return ErrorCode.UNAUTHORIZED;
    case 403: return ErrorCode.FORBIDDEN;
    case 404: return ErrorCode.NOT_FOUND;
    case 409: return ErrorCode.CONFLICT;
    case 429: return ErrorCode.CONCURRENCY_LIMIT;
    default: return ErrorCode.INTERNAL_ERROR;
  }
}

function flattenValidation(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m instanceof ValidationError) {
      return { property: m.property, constraints: m.constraints };
    }
    return { message: typeof m === 'string' ? m : String(m) };
  });
}
