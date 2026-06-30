/**
 * PdfSdkClient — sole egress to the PDF SDK (Java engine, `/v1/sync/*`).
 *
 * PDF SDK contract:
 *   - POST, multipart/form-data with a `request` **JSON part** + file parts.
 *   - Success = file attachment (arraybuffer). Error = JSON {code,message,traceId}
 *     with NO `errorCode`.
 *   - `X-ComPDF-License` header is attached from `req.__licenseToken` ONLY —
 *     never from body or env (architecture §8.1 red line). The token is passed
 *     in by the controller, which read it off the request the interceptor stamped.
 *
 * The client owns contract knowledge (paths + multipart field names). Controllers
 * forward user input; they do not need to know SDK field names.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import FormData from 'form-data';
import { decodeUpstreamError, UpstreamSdkError } from '../common/errors/upstream-sdk.error';

/** Minimal multer-file shape the client needs (works with @UploadedFile). */
export interface MulterFile {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
}

/** Result of a successful PDF SDK call (a result file). */
export interface SdkFileResult {
  buffer: Buffer;
  headers: Record<string, string>;
}

interface InternalPart {
  fieldname: string;
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

@Injectable()
export class PdfSdkClient {
  private readonly http: AxiosInstance;

  constructor(config: ConfigService) {
    const baseURL = config.get<string>('pdfSdk.baseUrl') ?? 'http://compdf-app:7001';
    this.http = axios.create({ baseURL, timeout: DEFAULT_TIMEOUT_MS });
  }

  // ---- P0 page operations -------------------------------------------------

  /** POST /v1/sync/pages/merge — `files[]` (ordered). */
  merge(files: MulterFile[], request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync(
      '/v1/sync/pages/merge',
      files.map((f) => ({ fieldname: 'files', ...f })),
      request,
      token,
    );
  }

  /** POST /v1/sync/pages/split — `file`, request.ranges[]. */
  split(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/pages/split', [toPart('file', file)], request, token);
  }

  /** POST /v1/sync/pages/extract — `file`. */
  extract(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/pages/extract', [toPart('file', file)], request, token);
  }

  /** POST /v1/sync/pages/insert-from-pdf — `file` + `insertFile`. */
  insertFromPdf(
    file: MulterFile,
    insertFile: MulterFile,
    request: Record<string, unknown>,
    token: string,
  ): Promise<SdkFileResult> {
    return this.callSync(
      '/v1/sync/pages/insert-from-pdf',
      [toPart('file', file), toPart('insertFile', insertFile)],
      request,
      token,
    );
  }

  /** POST /v1/sync/pages/insert-blank — `file`. */
  insertBlank(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/pages/insert-blank', [toPart('file', file)], request, token);
  }

  /** POST /v1/sync/pages/delete — `file`, request.pages[]. */
  delete(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/pages/delete', [toPart('file', file)], request, token);
  }

  /** POST /v1/sync/pages/rotate — `file`, request.pages[], request.angle. */
  rotate(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/pages/rotate', [toPart('file', file)], request, token);
  }

  // ---- Security -----------------------------------------------------------

  /** POST /v1/sync/security/encrypt — `file`. */
  encrypt(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/security/encrypt', [toPart('file', file)], request, token);
  }

  /** POST /v1/sync/security/decrypt — `file`, request.password. */
  decrypt(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/security/decrypt', [toPart('file', file)], request, token);
  }

  // ---- Watermarks ---------------------------------------------------------

  /** POST /v1/sync/watermarks/add — `file`, optional `imageFile` (type=image). */
  addWatermark(
    file: MulterFile,
    request: Record<string, unknown>,
    token: string,
    imageFile?: MulterFile,
  ): Promise<SdkFileResult> {
    const parts = [toPart('file', file)];
    if (imageFile) parts.push(toPart('imageFile', imageFile));
    return this.callSync('/v1/sync/watermarks/add', parts, request, token);
  }

  /** POST /v1/sync/watermarks/remove — `file`. */
  removeWatermark(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/watermarks/remove', [toPart('file', file)], request, token);
  }

  // ---- Standards / Optimize ----------------------------------------------

  /** POST /v1/sync/standards/convert — `file` + `iccFile` (PDF/A, PDF/X, ...). */
  convertStandard(
    file: MulterFile,
    iccFile: MulterFile,
    request: Record<string, unknown>,
    token: string,
  ): Promise<SdkFileResult> {
    return this.callSync(
      '/v1/sync/standards/convert',
      [toPart('file', file), toPart('iccFile', iccFile)],
      request,
      token,
    );
  }

  /** POST /v1/sync/optimize — compress/optimize `file`. */
  compress(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/optimize', [toPart('file', file)], request, token);
  }

  // ---- Core ---------------------------------------------------------------

  /**
   * Shared POST pipeline for every `/v1/sync/*` endpoint.
   * Builds multipart with a `request` JSON part (application/json) + file parts,
   * attaches `X-ComPDF-License`, returns the result file buffer on 2xx, and
   * throws UpstreamSdkError (PDF-SDK dialect: no errorCode) on failure.
   */
  protected async callSync(
    path: string,
    parts: InternalPart[],
    request: Record<string, unknown> | null,
    token: string,
  ): Promise<SdkFileResult> {
    const form = new FormData();
    // The `request` part is a plain form-data string field carrying serialized
    // JSON. The private SDK UI/reference shows it as type=string rather than an
    // application/json file-like part.
    if (request !== null) {
      form.append('request', JSON.stringify(request));
    }
    for (const p of parts) {
      form.append(p.fieldname, p.buffer, {
        filename: p.originalname,
        contentType: p.mimetype ?? 'application/octet-stream',
      });
    }
    const headers = { ...form.getHeaders(), 'X-ComPDF-License': token };

    try {
      const res: AxiosResponse<ArrayBuffer> = await this.http.post(path, form, {
        headers,
        responseType: 'arraybuffer',
      });
      return { buffer: Buffer.from(res.data), headers: res.headers as Record<string, string> };
    } catch (err) {
      throw this.toUpstreamError(err);
    }
  }

  /** Exposed for subclasses/tests to inject a custom axios instance. */
  protected setHttp(http: AxiosInstance): void {
    (this as unknown as { http: AxiosInstance }).http = http;
  }

  private toUpstreamError(err: unknown): UpstreamSdkError {
    const e = err as { response?: AxiosResponse<ArrayBuffer>; message?: string };
    if (e.response) {
      return decodeUpstreamError(e.response.data, e.response.status);
    }
    // Network / timeout — no upstream body. Surface a neutral upstream error.
    return new UpstreamSdkError({
      status: 0,
      code: 0,
      message: e.message ?? 'PDF SDK request failed',
    });
  }
}

function toPart(fieldname: string, file: MulterFile): InternalPart {
  return {
    fieldname,
    buffer: file.buffer,
    originalname: file.originalname,
    mimetype: file.mimetype,
  };
}
