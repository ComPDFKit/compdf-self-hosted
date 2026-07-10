/**
 * ConversionClient — sole egress to the conversion engine (Python, `/v1/*`).
 *
 * Conversion engine contract:
 *   - POST /v1/convert: multipart FLAT form fields (file + target + options[JSON]
 *     + password). One `target` param covers PDF→{docx,xlsx,pptx,html,rtf,txt,
 *     csv,json,png,jpeg}. There is NO page-count endpoint (page limit is enforced
 *     server-side via 100105 PAGE_LIMIT_EXCEEDED 422, never queried).
 *   - POST /v1/convert-to-pdf: doc→PDF (Word/Excel/PPT/TXT/HTML/RTF/image/CSV).
 *   - POST /v1/documentai/{operation}: image AI ops (layout/ocr/table/stamp/
 *     magic-color/dewarp) — thin forward-compat wrapper.
 *   - Async flow (POST /v1/jobs + poll) — thin forward-compat helpers; P0 uses
 *     sync /v1/convert.
 *   - Success = file stream (arraybuffer). Error = JSON {code,errorCode,message,
 *     traceId} — HAS `errorCode` (the second dialect; see §4).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import FormData from 'form-data';
import { decodeUpstreamError, UpstreamSdkError } from '../common/errors/upstream-sdk.error';
import { normalizeUploadedFilename } from '../common/utils/filename';
import type { MulterFile, SdkFileResult } from './pdf-sdk.client';

export type { MulterFile, SdkFileResult } from './pdf-sdk.client';

/** Allowed `target` values for /v1/convert (PDF → X). */
export type ConvertTarget =
  | 'docx' | 'xlsx' | 'pptx' | 'html' | 'rtf'
  | 'txt' | 'csv' | 'json' | 'png' | 'jpeg' | 'jpg';

/** Allowed `/v1/documentai` operations (image AI). */
export type DocumentAiOperation =
  | 'layout' | 'ocr' | 'table' | 'stamp' | 'magic-color' | 'dewarp';

const DEFAULT_TIMEOUT_MS = 300_000; // CONVERT_TIMEOUT default is 300s
const LICENSE_TYPE_CACHE_MS = 30_000;

export interface LicenseTypeResult {
  licenseType: 'UNKNOWN' | 'TRIAL' | 'FORMAL';
  value: 0 | 1 | 2;
  isFormalLicense: boolean;
}

@Injectable()
export class ConversionClient {
  private readonly logger = new Logger(ConversionClient.name);
  private readonly http: AxiosInstance;
  private readonly baseURL: string;
  private licenseTypeCache: { result: LicenseTypeResult; expiresAt: number } | null = null;

  constructor(config: ConfigService) {
    const baseURL = config.get<string>('conversion.baseUrl') ?? 'http://compdf-app:7000';
    this.baseURL = baseURL;
    this.http = axios.create({ baseURL, timeout: DEFAULT_TIMEOUT_MS });
  }

  async getLicenseType(): Promise<LicenseTypeResult> {
    if (this.licenseTypeCache && this.licenseTypeCache.expiresAt > Date.now()) {
      return this.licenseTypeCache.result;
    }
    try {
      const response = await this.http.get('/v1/license-type');
      const value = response?.data?.value;
      const result: LicenseTypeResult = value === 2
        ? { licenseType: 'FORMAL', value: 2, isFormalLicense: true }
        : value === 1
          ? { licenseType: 'TRIAL', value: 1, isFormalLicense: false }
          : { licenseType: 'UNKNOWN', value: 0, isFormalLicense: false };
      this.licenseTypeCache = { result, expiresAt: Date.now() + LICENSE_TYPE_CACHE_MS };
      return result;
    } catch (err) {
      this.logger.warn(`license type lookup failed: ${(err as Error).message}`);
      return { licenseType: 'UNKNOWN', value: 0, isFormalLicense: false };
    }
  }

  /**
   * POST /v1/convert — sync PDF→{word,excel,ppt,html,txt,csv,rtf,json,image}.
   * `target` selects the output format. `options` is JSON-stringified per §3.5.
   */
  convert(
    file: MulterFile,
    target: ConvertTarget,
    token: string,
    options?: Record<string, unknown>,
    password?: string,
  ): Promise<SdkFileResult> {
    return this.postFileForm(
      '/v1/convert',
      file,
      token,
      { target, options: stringifyOptions(options), password },
    );
  }

  /**
   * POST /v1/convert with `type` (executeType) instead of `target`. Used for
   * img/* (image→X), pdf/pdf (searchable PDF), pdf/ofd, pdf/markdown — formats
   * the engine only reaches via `type`, never `target` (see API ref §6.5).
   * `target` and `type` are mutually exclusive on the engine side.
   */
  convertByType(
    file: MulterFile,
    type: string,
    token: string,
    options?: Record<string, unknown>,
    password?: string,
  ): Promise<SdkFileResult> {
    return this.postFileForm(
      '/v1/convert',
      file,
      token,
      { type, options: stringifyOptions(options), password },
    );
  }

  /**
   * POST /v1/convert-to-pdf — doc→PDF via LibreOffice. The conversion engine
   * API reference only accepts `file` + optional `type`; options/password are
   * kept in the method signature for controller/task compatibility but are not
   * forwarded.
   */
  convertToPdf(
    file: MulterFile,
    token: string,
    type?: string,
    _options?: Record<string, unknown>,
    _password?: string,
  ): Promise<SdkFileResult> {
    return this.postFileForm(
      '/v1/convert-to-pdf',
      file,
      token,
      { type },
    );
  }

  /**
   * POST /v1/documentai/{operation} — sync image AI ops.
   * Output: JSON for layout/ocr/table/stamp; image stream for magic-color/dewarp.
   * Thin forward-compat wrapper.
   */
  documentAi(
    operation: DocumentAiOperation,
    file: MulterFile,
    token: string,
    options?: Record<string, unknown>,
  ): Promise<SdkFileResult> {
    return this.postFileForm(
      `/v1/documentai/${operation}`,
      file,
      token,
      { options: options ? JSON.stringify(options) : undefined },
    );
  }

  // ---- Async flow (forward-compat; P0 uses sync /v1/convert) -------------

  /** POST /v1/documents — pre-upload a PDF/image for async jobs. */
  async preUploadDocument(
    file: MulterFile,
    token: string,
  ): Promise<{ id: string; filename: string; sha256: string; size: number; mimeType: string; createdAt: string }> {
    const form = new FormData();
    form.append('file', file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype ?? 'application/octet-stream',
    });
    return this.postJson('/v1/documents', form, token);
  }

  /** POST /v1/jobs — create an async job. */
  createJob(body: Record<string, unknown>, token: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.http.post('/v1/jobs', body, { headers }).then(
      (r) => r.data,
      (e) => { throw this.toUpstreamError(e); },
    );
  }

  /** GET /v1/jobs/{id} — job detail. */
  getJob(id: string, token: string): Promise<Record<string, unknown>> {
    return this.http
      .get(`/v1/jobs/${encodeURIComponent(id)}`)
      .then((r) => r.data, (e) => { throw this.toUpstreamError(e); });
  }

  /**
   * GET /v1/jobs/{id}/result — on success returns 302 with
   * `Location: /v1/jobs/{id}/download`. Resolves to the download URL.
   */
  async getJobResult(id: string, token: string): Promise<string> {
    try {
      const res = await this.http.get(`/v1/jobs/${encodeURIComponent(id)}/result`, {
        maxRedirects: 0,
        validateStatus: (s) => s === 302,
      });
      return String(res.headers?.location ?? `/v1/jobs/${encodeURIComponent(id)}/download`);
    } catch (err) {
      throw this.toUpstreamError(err);
    }
  }

  /** GET /v1/jobs/{id}/download — 200 file stream. */
  async downloadJob(id: string, token: string): Promise<SdkFileResult> {
    try {
      const res: AxiosResponse<ArrayBuffer> = await this.http.get(
        `/v1/jobs/${encodeURIComponent(id)}/download`,
        { responseType: 'arraybuffer' },
      );
      return { buffer: Buffer.from(res.data), headers: res.headers as Record<string, string> };
    } catch (err) {
      throw this.toUpstreamError(err);
    }
  }

  // ---- Core ---------------------------------------------------------------

  /**
   * POST a multipart form with FLAT string fields (file + scalar fields) — the
   * conversion engine's request shape, distinct from the PDF SDK's `request`
   * JSON part. `fields` values are stringified; undefined fields are omitted.
   */
  protected async postFileForm(
    path: string,
    file: MulterFile,
    token: string,
    fields: Record<string, string | undefined>,
  ): Promise<SdkFileResult> {
    const startedAt = Date.now();
    const form = new FormData();
    const filename = normalizeUploadedFilename(file.originalname);
    form.append('file', file.buffer, {
      filename,
      contentType: file.mimetype ?? 'application/octet-stream',
    });
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') {
        form.append(k, String(v));
      }
    }
    const headers = form.getHeaders();
    this.logger.log(`conversion upstream request ${JSON.stringify({
      url: `${this.baseURL}${path}`,
      path,
      file: fileSummary(file),
      fields: safeFieldsForLog(fields),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })}`);
    try {
      const res: AxiosResponse<ArrayBuffer> = await this.http.post(path, form, {
        headers,
        responseType: 'arraybuffer',
      });
      if (res.status !== 200) {
        throw decodeUpstreamError(res.data, res.status);
      }
      const buffer = Buffer.from(res.data);
      this.logger.debug(`conversion upstream success ${JSON.stringify({
        url: `${this.baseURL}${path}`,
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
      this.logger.error(`conversion upstream failure ${JSON.stringify({
        url: `${this.baseURL}${path}`,
        path,
        file: fileSummary(file),
        fields: safeFieldsForLog(fields),
        status: upstream.status,
        code: upstream.code,
        errorCode: upstream.errorCode,
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

  private async postJson(path: string, form: FormData, token: string): Promise<any> {
    try {
      const res = await this.http.post(path, form, {
        headers: form.getHeaders(),
      });
      return res.data;
    } catch (err) {
      throw this.toUpstreamError(err);
    }
  }

  protected toUpstreamError(err: unknown): UpstreamSdkError {
    if (err instanceof UpstreamSdkError) return err;
    const e = err as { response?: AxiosResponse<ArrayBuffer>; message?: string };
    if (e.response) {
      return decodeUpstreamError(e.response.data, e.response.status);
    }
    return new UpstreamSdkError({
      status: 0,
      code: 0,
      message: e.message ?? 'conversion request failed',
    });
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  return typeof direct === 'string' ? direct : undefined;
}

function fileSummary(file: MulterFile): Record<string, unknown> {
  const withSize = file as MulterFile & { size?: number };
  return {
    originalname: normalizeUploadedFilename(file.originalname),
    mimetype: file.mimetype,
    size: withSize.size ?? file.buffer?.length,
  };
}

function safeFieldsForLog(fields: Record<string, string | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (isSensitiveField(key)) {
      result[`${key}Present`] = true;
      continue;
    }
    if (key === 'options') {
      result.options = safeJsonStringForLog(value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function safeJsonStringForLog(value: string): unknown {
  try {
    const parsed = JSON.parse(value);
    return sanitizeObjectForLog(parsed);
  } catch {
    return '[invalid-json]';
  }
}

function sanitizeObjectForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeObjectForLog(item));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveField(key) ? '[redacted]' : sanitizeObjectForLog(child);
  }
  return result;
}

function isSensitiveField(key: string): boolean {
  return /password|token|license|secret/i.test(key);
}

const NUMERIC_TOGGLE_OPTION_KEYS = new Set([
  'enableAiLayout',
  'isContainImg',
  'isContainAnnot',
  'enableOcr',
  'containPageBackgroundImage',
  'formulaToImage',
  'isOutputDocumentPerPage',
  'transparentText',
  'txtTableFormat',
  'excelAllContent',
]);

function stringifyOptions(options?: Record<string, unknown>): string | undefined {
  if (!options) return undefined;
  return JSON.stringify(normalizeConversionOptions(options));
}

function normalizeConversionOptions(options: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'imageFormat' && typeof value === 'string') {
      result[key] = value.toUpperCase();
      continue;
    }
    if (NUMERIC_TOGGLE_OPTION_KEYS.has(key) && (value === '0' || value === '1')) {
      result[key] = Number(value);
      continue;
    }
    result[key] = value;
  }
  return result;
}
