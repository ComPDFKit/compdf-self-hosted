/**
 * AllExceptionsFilter — single normalization point for ALL errors leaving the
 * server. SDK business errors use HTTP 200; server errors keep their 4xx/5xx
 * status. The JSON body always uses:
 * `{ type, code, errorCode, message, traceId }`.
 *
 * `code` is the six-digit business code. SDK errors preserve the upstream
 * numeric code; server errors map their semantic errorCode to the same ranges.
 * PDF SDK errors do not carry errorCode, so it is derived from the documented
 * PDF SDK code table. Conversion errors preserve the upstream errorCode.
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
import { randomUUID } from 'crypto';
import { ErrorCode, numericCodeForServerError, semanticErrorCodeForBizCode } from '../errors/error-codes';
import { processingErrorDefinition } from '../errors/processing-error-catalog';
import { UpstreamSdkError } from '../errors/upstream-sdk.error';

export interface NormalizedError {
  statusCode: number;
  body: {
    type: 'conversion' | 'pdf' | 'server';
    code: number;
    errorCode: string;
    message: string;
    traceId: string;
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
      this.logger.error(`${body.code} ${body.errorCode}: ${body.message}`, exception instanceof Error ? exception.stack : undefined);
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
        type: 'server',
        code: 190999,
        errorCode: ErrorCode.INTERNAL_ERROR,
        message: 'Internal server error.',
        traceId: createTraceId(),
      },
    };
  }

  private static normalizeUpstream(err: UpstreamSdkError): NormalizedError {
    // Processing SDK failures are business errors. Keep their numeric code in
    // the response body and avoid exposing them as abnormal HTTP statuses.
    const statusCode = 200;
    const code = err.code > 0 ? err.code : 190999;
    const errorCode = err.errorCode
      ?? (err.code > 0
        ? semanticErrorCodeForBizCode(err.code, err.isConversion ? 'conversion' : 'pdf')
        : undefined)
      ?? ErrorCode.UPSTREAM_ERROR;
    return {
      statusCode,
      body: {
        type: err.source,
        code,
        errorCode,
        message: englishUpstreamMessage(err.message, errorCode, err.source, code),
        traceId: err.traceId ?? createTraceId(),
      },
    };
  }

  private static normalizeHttp(err: HttpException): NormalizedError {
    const status = err.getStatus();
    const resp = err.getResponse();

    // ValidationPipe BadRequest: resp may be { message: ValidationError[], error, statusCode }
    if (status === 400 && Array.isArray((resp as any)?.message)) {
      return {
        statusCode: 400,
        body: serverErrorBody(400, ErrorCode.VALIDATION_ERROR, validationMessage((resp as any).message)),
      };
    }

    // Our own HttpExceptions carry a semantic { code, message } payload. The
    // semantic code becomes errorCode and maps to a six-digit numeric code.
    if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
      const r = resp as Record<string, unknown>;
      const errorCode = typeof r.code === 'string' ? r.code : httpCodeFor(status);
      const message = typeof r.message === 'string' ? r.message : err.message;
      return { statusCode: status, body: serverErrorBody(status, errorCode, message) };
    }

    return {
      statusCode: status,
      body: serverErrorBody(status, httpCodeFor(status), typeof resp === 'string' ? resp : err.message),
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
    case 408:
    case 504: return ErrorCode.REQUEST_TIMEOUT;
    case 413: return ErrorCode.FILE_TOO_LARGE;
    case 429: return ErrorCode.CONCURRENCY_LIMIT;
    case 503: return ErrorCode.SERVICE_MAINTENANCE;
    default: return ErrorCode.INTERNAL_ERROR;
  }
}

function validationMessage(messages: unknown[]): string {
  const parts = messages.flatMap((m): string[] => {
    if (m instanceof ValidationError) {
      return m.constraints ? Object.values(m.constraints) : [`${m.property} is invalid`];
    }
    return [typeof m === 'string' ? m : String(m)];
  });
  return parts.join('; ') || 'Validation failed.';
}

function serverErrorBody(status: number, errorCode: string, message: string): NormalizedError['body'] {
  return {
    type: 'server',
    code: numericCodeForServerError(errorCode, status),
    errorCode,
    message,
    traceId: createTraceId(),
  };
}

function createTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

function englishUpstreamMessage(
  message: string,
  errorCode: string,
  source: 'conversion' | 'pdf',
  code: number,
): string {
  if (!/[\u3400-\u9fff]/u.test(message)) return message;
  return processingErrorDefinition(source, code)?.message
    ?? ENGLISH_UPSTREAM_MESSAGES[errorCode]
    ?? 'The processing service request failed.';
}

const ENGLISH_UPSTREAM_MESSAGES: Readonly<Record<string, string>> = {
  INTERNAL_ERROR: 'The processing service encountered an internal error.',
  UPSTREAM_ERROR: 'The processing service request failed.',
  CONVERT_FAILED: 'Document conversion failed.',
  SDK_PROCESS_FAILED: 'PDF processing failed.',
  FILE_TOO_LARGE: 'The file exceeds the service size limit.',
  PDF_PASSWORD_ERROR: 'The PDF password is incorrect or missing.',
  INVALID_PASSWORD: 'The PDF password is incorrect.',
  REQUEST_TIMEOUT: 'The processing request timed out.',
  JOB_TIMEOUT: 'Document conversion timed out.',
  SYNC_WAIT_TIMEOUT: 'The synchronous processing request timed out.',
  LICENSE_EXPIRED: 'The processing license has expired.',
  LICENSE_INVALID: 'The processing license is invalid.',
  LICENSE_MISSING: 'The processing license is missing.',
  CONCURRENCY_EXCEEDED: 'The processing concurrency limit has been reached.',
};
