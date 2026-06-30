/**
 * AllExceptionsFilter — single normalization point for ALL errors leaving the
 * server. Local middleware errors keep the project error shape. Upstream SDK
 * errors are returned in the same OpenAPI-style shape exposed by the closed
 * services: `{ code, message, traceId, errorCode? }`.
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
import { ErrorCode } from '../errors/error-codes';
import { UpstreamSdkError } from '../errors/upstream-sdk.error';

export interface NormalizedError {
  statusCode: number;
  body: {
    code: string | number;
    message: string;
    traceId?: string;
    errorCode?: string;
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
      this.logger.error(`${body.code}: ${body.message}`, exception instanceof Error ? exception.stack : undefined);
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
        code: ErrorCode.INTERNAL_ERROR,
        message: 'internal server error',
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
      code: err.code,
      message: err.message,
      traceId: err.traceId,
    };
    if (err.errorCode) body.errorCode = err.errorCode;
    return {
      statusCode,
      body,
    };
  }

  private static normalizeHttp(err: HttpException): NormalizedError {
    const status = err.getStatus();
    const resp = err.getResponse();

    // ValidationPipe BadRequest: resp may be { message: ValidationError[], error, statusCode }
    if (status === 400 && Array.isArray((resp as any)?.message)) {
      const details = flattenValidation((resp as any).message);
      return {
        statusCode: 400,
        body: { code: ErrorCode.VALIDATION_ERROR, message: 'validation failed', details },
      };
    }

    // Our own thrown HttpExceptions carry a { code, message } payload (e.g.
    // UnauthorizedException from AuthController). Surface that code if present.
    if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
      const r = resp as Record<string, unknown>;
      const code = typeof r.code === 'string' ? r.code : httpCodeFor(status);
      const message = typeof r.message === 'string' ? r.message : err.message;
      return { statusCode: status, body: { code, message, details: r.details } };
    }

    return {
      statusCode: status,
      body: { code: httpCodeFor(status), message: typeof resp === 'string' ? resp : err.message },
    };
  }
}

function httpCodeFor(status: number): string {
  switch (status) {
    case 400: return ErrorCode.BAD_REQUEST;
    case 401: return ErrorCode.UNAUTHORIZED;
    case 403: return ErrorCode.FORBIDDEN;
    case 404: return ErrorCode.NOT_FOUND;
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
