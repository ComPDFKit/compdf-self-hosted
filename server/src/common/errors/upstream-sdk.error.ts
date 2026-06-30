/**
 * Unified error thrown by SDK clients when an upstream (PDF SDK / conversion
 * engine) call fails. Carries the raw upstream fields so the AllExceptionsFilter
 * can detect the dialect and normalize — WITHOUT the server interpreting or
 * enforcing any license limits (those live in the closed-source app).
 *
 * Two upstream dialects (see docs/sdk-contract.md §4):
 *   PDF SDK:     { code, message, traceId }              — NO errorCode
 *   Conversion:  { code, errorCode, message, traceId }   — HAS errorCode
 *
 * Detection rule: `errorCode` field presence identifies the conversion engine.
 * Do NOT branch on the numeric `code` range (ranges overlap by design).
 */
export class UpstreamSdkError extends Error {
  /** Upstream HTTP status (e.g. 400/402/422/429). */
  public readonly status: number;
  /** Upstream 6-digit numeric code. */
  public readonly code: number;
  /** Upstream traceId (hex for PDF SDK, UUID for conversion). */
  public readonly traceId?: string;
  /** Present ONLY for conversion-engine errors. Absent for PDF SDK errors. */
  public readonly errorCode?: string;

  constructor(opts: {
    status: number;
    code: number;
    message: string;
    traceId?: string;
    errorCode?: string;
  }) {
    super(opts.message);
    this.name = 'UpstreamSdkError';
    this.status = opts.status;
    this.code = opts.code;
    this.traceId = opts.traceId;
    this.errorCode = opts.errorCode;
  }

  /** True when the error came from the conversion engine (errorCode present). */
  get isConversion(): boolean {
    return typeof this.errorCode === 'string';
  }
}

/**
 * Decode an upstream error body. Upstream calls use `responseType: 'arraybuffer'`
 * (success returns a file), so error bodies arrive as a Buffer that is actually
 * JSON. This parses it and detects the dialect by `errorCode` presence.
 *
 * Accepts either a Buffer (axios arraybuffer) or an already-parsed object.
 */
export function decodeUpstreamError(
  body: Buffer | ArrayBuffer | string | Record<string, unknown> | undefined,
  status: number,
): UpstreamSdkError {
  let parsed: Record<string, unknown> | undefined;
  let buf: Buffer | undefined;

  if (body == null) {
    parsed = undefined;
  } else if (Buffer.isBuffer(body)) {
    buf = body;
  } else if (body instanceof ArrayBuffer) {
    buf = Buffer.from(body);
  } else if (ArrayBuffer.isView(body) && !(body instanceof DataView)) {
    // TypedArray view (axios may return Uint8Array for responseType arraybuffer)
    const view = body as unknown as Uint8Array;
    buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  } else if (typeof body === 'string') {
    buf = Buffer.from(body, 'utf8');
  } else if (typeof body === 'object') {
    parsed = body as Record<string, unknown>;
  }

  if (buf !== undefined) {
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      parsed = undefined;
    }
  }

  const code = Number(parsed?.code);
  const rawMessage =
    typeof parsed?.message === 'string' ? parsed.message : 'upstream SDK error';
  const message = normalizeUpstreamMessage(rawMessage);
  const traceId =
    typeof parsed?.traceId === 'string' ? parsed.traceId : undefined;
  const errorCode =
    typeof parsed?.errorCode === 'string' ? parsed.errorCode : undefined;

  return new UpstreamSdkError({
    status,
    code: Number.isFinite(code) ? code : 0,
    message,
    traceId,
    errorCode,
  });
}

function normalizeUpstreamMessage(message: string): string {
  const syncWaitTimeout = message.match(
    /^同步等待超时[（(]([^)）]+)[）)]，任务仍在后台运行，请用\s*(\S+)\s*查询$/,
  );
  if (syncWaitTimeout) {
    const [, duration, taskPath] = syncWaitTimeout;
    return `Synchronous wait timed out (${duration}). The task is still running in the background. Use ${taskPath} to query its status.`;
  }
  return message;
}
