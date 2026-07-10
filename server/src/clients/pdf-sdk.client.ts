/**
 * PdfSdkClient — sole egress to the PDF SDK (Java engine, `/v1/sync/*`).
 *
 * PDF SDK contract:
 *   - POST, multipart/form-data with a `request` **JSON part** + file parts.
 *   - Success = file attachment (arraybuffer). Error = JSON {code,message,traceId}
 *     with NO `errorCode`.
 *
 * The client owns contract knowledge (paths + multipart field names). Controllers
 * forward user input; they do not need to know SDK field names.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import FormData from 'form-data';
import { decodeUpstreamError, UpstreamSdkError } from '../common/errors/upstream-sdk.error';
import { normalizeUploadedFilename } from '../common/utils/filename';

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
  private readonly logger = new Logger(PdfSdkClient.name);
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
      normalizeMergeRequest(request),
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
      stripRequestKeys(request, ['actionType', 'password']),
      token,
    );
  }

  /** POST /v1/sync/pages/insert-blank — `file`. */
  insertBlank(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/pages/insert-blank', [toPart('file', file)], stripRequestKeys(request, ['actionType']), token);
  }

  /** POST /v1/sync/pages/delete — `file`, request.pages[]. */
  delete(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/pages/delete', [toPart('file', file)], normalizePagesRequest(request), token);
  }

  /** POST /v1/sync/pages/rotate — `file`, request.pages (number[] or 'all'), request.angle. */
  rotate(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/pages/rotate', [toPart('file', file)], normalizePagesRequest(request, { allPagesValue: 'all' }), token);
  }

  // ---- Security -----------------------------------------------------------

  /** POST /v1/sync/security/encrypt — `file`. */
  encrypt(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/security/encrypt', [toPart('file', file)], normalizeEncryptRequest(request), token);
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
    return this.callSync('/v1/sync/watermarks/add', parts, stripRequestKeys(request, ['password']), token);
  }

  /** POST /v1/sync/watermarks/remove — `file`. */
  removeWatermark(file: MulterFile, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    return this.callSync('/v1/sync/watermarks/remove', [toPart('file', file)], normalizeRemoveWatermarkRequest(request), token);
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
    return this.callSync('/v1/sync/optimize', [toPart('file', file)], normalizeCompressRequest(request), token);
  }

  // ---- Generation ---------------------------------------------------------

  /** POST /v1/sync/generation/html-to-pdf — optional `htmlFile`. */
  htmlToPdf(htmlFile: MulterFile | undefined, request: Record<string, unknown>, token: string): Promise<SdkFileResult> {
    const parts = htmlFile ? [toPart('htmlFile', htmlFile)] : [];
    return this.callSync('/v1/sync/generation/html-to-pdf', parts, request, token);
  }

  /** POST /v1/sync/generation/template-to-pdf — optional `templateFile` + `dataFile`. */
  templateToPdf(
    templateFile: MulterFile | undefined,
    dataFile: MulterFile | undefined,
    request: Record<string, unknown>,
    token: string,
  ): Promise<SdkFileResult> {
    const parts: InternalPart[] = [];
    if (templateFile) parts.push(toPart('templateFile', templateFile));
    if (dataFile) parts.push(toPart('dataFile', dataFile));
    return this.callSync('/v1/sync/generation/template-to-pdf', parts, request, token);
  }

  // ---- Core ---------------------------------------------------------------

  /**
   * Shared POST pipeline for every `/v1/sync/*` endpoint.
   * Builds multipart with a `request` JSON part (application/json) + file parts,
   * returns the result file buffer on 2xx, and throws UpstreamSdkError
   * (PDF-SDK dialect: no errorCode) on failure.
   */
  protected async callSync(
    path: string,
    parts: InternalPart[],
    request: Record<string, unknown> | null,
    token: string,
  ): Promise<SdkFileResult> {
    const startedAt = Date.now();
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
    const headers = form.getHeaders();
    this.logger.log(`pdf sdk upstream request ${JSON.stringify({
      path,
      files: parts.map(partSummary),
      request: sanitizeObjectForLog(request),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })}`);

    try {
      const res: AxiosResponse<ArrayBuffer> = await this.http.post(path, form, {
        headers,
        responseType: 'arraybuffer',
      });
      const buffer = Buffer.from(res.data);
      this.logger.debug(`pdf sdk upstream success ${JSON.stringify({
        path,
        status: res.status,
        contentType: headerValue(res.headers, 'content-type'),
        contentDisposition: headerValue(res.headers, 'content-disposition'),
        responseBytes: buffer.length,
        durationMs: Date.now() - startedAt,
      })}`);
      return { buffer, headers: res.headers as Record<string, string> };
    } catch (err) {
      const upstream = this.toUpstreamError(err);
      this.logger.error(`pdf sdk upstream failure ${JSON.stringify({
        path,
        files: parts.map(partSummary),
        request: sanitizeObjectForLog(request),
        status: upstream.status,
        code: upstream.code,
        traceId: upstream.traceId,
        message: upstream.message,
      })}`);
      throw upstream;
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
    originalname: normalizeUploadedFilename(file.originalname),
    mimetype: file.mimetype,
  };
}

function partSummary(part: InternalPart): Record<string, unknown> {
  return {
    fieldname: part.fieldname,
    originalname: part.originalname,
    mimetype: part.mimetype,
    size: part.buffer?.length,
  };
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  return typeof direct === 'string' ? direct : undefined;
}

function sanitizeObjectForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeObjectForLog(item));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = /password|token|license|secret/i.test(key) ? '[redacted]' : sanitizeObjectForLog(child);
  }
  return result;
}

const PERMISSION_KEYS = [
  'allowPrint',
  'allowCopy',
  'allowDocumentChanges',
  'allowDocumentAssembly',
  'allowCommenting',
  'allowFormFieldEntry',
];

const COMPRESS_PRESET_FLAGS: Record<'low' | 'medium' | 'high', string[]> = {
  low: ['RMEMBFONT', 'RMFORMCOMMITIMPORTRESETACTION', 'RMJSACTION', 'RMPAGETHUMBNAIL', 'RMLABEL', 'RMBK', 'RMANNOT', 'RMFORM', 'RMMULMEDIA', 'RMDOCINFO', 'RMMEDTADATA', 'RMOBJDATA', 'RMFILEATTACHMENT', 'RMHIDERLAYER', 'MERGEVISIBLELAYER', 'RMINVABK', 'RMINVALINK'],
  medium: ['RMFORMCOMMITIMPORTRESETACTION', 'RMJSACTION', 'RMPAGETHUMBNAIL', 'RMLABEL', 'RMDOCINFO', 'RMMEDTADATA', 'RMOBJDATA', 'RMINVABK', 'RMINVALINK'],
  high: ['RMPAGETHUMBNAIL', 'RMINVABK', 'RMINVALINK'],
};

function normalizeMergeRequest(request: Record<string, unknown>): Record<string, unknown> {
  return stripRequestKeys(request, ['password']);
}

function normalizePagesRequest(
  request: Record<string, unknown>,
  opts: { allPagesValue?: string } = {},
): Record<string, unknown> {
  const allPagesValue = opts.allPagesValue ?? '';
  const result = { ...request };
  const hasPageRanges = Object.prototype.hasOwnProperty.call(result, 'pageRanges');
  const rawPageRanges = result.pageRanges;
  delete result.pageRanges;
  delete result.pages;

  if (!hasPageRanges) {
    result.pages = allPagesValue;
    return result;
  }
  if (isAllPageSelection(rawPageRanges)) {
    result.pages = allPagesValue;
    return result;
  }
  result.pages = toPageNumbers(rawPageRanges);
  return result;
}

function normalizeCompressRequest(request: Record<string, unknown>): Record<string, unknown> {
  const result = { ...request };
  const profile = result.profile;
  delete result.profile;
  if (!Array.isArray(result.optimizeFlags) && profile === 'aggressive') {
    const quality = Number(result.imageQuality);
    result.optimizeFlags = quality <= 30
      ? COMPRESS_PRESET_FLAGS.low
      : quality <= 60
        ? COMPRESS_PRESET_FLAGS.medium
        : COMPRESS_PRESET_FLAGS.high;
  }
  return result;
}

function normalizeEncryptRequest(request: Record<string, unknown>): Record<string, unknown> {
  const result = { ...request };
  const permissions = isRecord(result.permissions) ? { ...result.permissions } : {};
  for (const key of PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      permissions[key] = result[key];
      delete result[key];
    }
  }
  if (Object.keys(permissions).length > 0) result.permissions = permissions;
  return result;
}

function normalizeRemoveWatermarkRequest(request: Record<string, unknown>): Record<string, unknown> {
  const result = stripRequestKeys(request, ['password']);
  if (!Object.prototype.hasOwnProperty.call(result, 'pages')) return result;
  const pages = result.pages;
  if (pages === '' || pages === 'all' || pages === undefined || pages === null) {
    delete result.pages;
    return result;
  }
  result.mode = 'untagged';
  result.pages = toPageNumbers(pages);
  return result;
}

function stripRequestKeys(request: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result = { ...request };
  for (const key of keys) delete result[key];
  return result;
}

function isAllPageSelection(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' || trimmed.toLowerCase() === 'all';
  }
  return Array.isArray(value) && value.length === 0;
}

function toPageNumbers(value: unknown): number[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => toPageNumbers(item)))];
  }
  if (typeof value === 'number' && Number.isInteger(value)) return [value];
  if (typeof value !== 'string') return [];
  const pages: number[] = [];
  for (const part of value.split(/[;,]/).map((item) => item.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const step = start <= end ? 1 : -1;
      for (let page = start; page !== end + step; page += step) pages.push(page);
      continue;
    }
    const page = Number(part);
    if (Number.isInteger(page)) pages.push(page);
  }
  return [...new Set(pages)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
