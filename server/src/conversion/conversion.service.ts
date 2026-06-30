/**
 * ConversionService — wraps ConversionClient and captures truncation headers
 * (architecture §8.2, forward-compatible per correction #3 / R4).
 *
 * The real conversion service does NOT currently emit `x-compdf-truncated` /
 * `x-compdf-pages-processed` / `x-compdf-pages-total`; current behaviour is
 * 422 `PAGE_LIMIT_EXCEEDED` on limit. This service parses the headers if they
 * are present and defaults to `truncated=false` when absent.
 *
 * It contains NO page-limit/concurrency enforcement of its own — limits live in
 * the closed-source app (architecture §5). This layer only translates the SDK's
 * truncation signal for the frontend.
 */
import { Injectable } from '@nestjs/common';
import { ConversionClient, ConvertTarget, MulterFile } from '../clients/conversion.client';

export interface ConversionResult {
  buffer: Buffer;
  truncated: boolean;
  /** Pages actually processed, when the SDK reports a partial result. */
  processed?: number;
  /** Total pages in the source document, when the SDK reports a partial result. */
  total?: number;
  /** Result filename parsed from Content-Disposition, if present. */
  filename?: string;
  /** Upstream Content-Type, so the controller can echo it on the response. */
  contentType?: string;
}

@Injectable()
export class ConversionService {
  constructor(private readonly client: ConversionClient) {}

  /** POST /v1/convert — PDF → {word,excel,ppt,html,txt,csv,rtf,json,image}. */
  async convert(
    file: MulterFile,
    target: ConvertTarget,
    token: string,
    options?: Record<string, unknown>,
    password?: string,
  ): Promise<ConversionResult> {
    const res = await this.client.convert(file, target, token, options, password);
    return this.withTruncation(res.buffer, res.headers);
  }

  /** POST /v1/convert with `type` (img/*, pdf/pdf, pdf/ofd, img/json, …). */
  async convertByType(
    file: MulterFile,
    type: string,
    token: string,
    options?: Record<string, unknown>,
    password?: string,
  ): Promise<ConversionResult> {
    const res = await this.client.convertByType(file, type, token, options, password);
    return this.withTruncation(res.buffer, res.headers);
  }

  /** POST /v1/convert-to-pdf — doc → PDF. */
  async convertToPdf(
    file: MulterFile,
    token: string,
    type?: string,
    options?: Record<string, unknown>,
    password?: string,
  ): Promise<ConversionResult> {
    const res = await this.client.convertToPdf(file, token, type, options, password);
    return this.withTruncation(res.buffer, res.headers);
  }

  /** POST /v1/documentai/{operation} — image AI ops (forward-compat). */
  async documentAi(
    operation: Parameters<ConversionClient['documentAi']>[0],
    file: MulterFile,
    token: string,
    options?: Record<string, unknown>,
  ): Promise<ConversionResult> {
    const res = await this.client.documentAi(operation, file, token, options);
    return this.withTruncation(res.buffer, res.headers);
  }

  /**
   * Parse the (optional, forward-compat) truncation headers. Lower-cases header
   * names for case-insensitive lookup. Defaults to `truncated=false` when the
   * header is absent — matching the current live service behaviour.
   */
  private withTruncation(
    buffer: Buffer,
    headers: Record<string, string>,
  ): ConversionResult {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lower[String(k).toLowerCase()] = String(v);
    }
    const truncated = lower['x-compdf-truncated'] === 'true';
    const processed = toInt(lower['x-compdf-pages-processed']);
    const total = toInt(lower['x-compdf-pages-total']);
    const filename = parseFilename(lower['content-disposition']);
    const contentType = lower['content-type'];
    return { buffer, truncated, processed, total, filename, contentType };
  }
}

function toInt(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseFilename(contentDisposition: string | undefined): string | undefined {
  if (!contentDisposition) return undefined;
  const m = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : undefined;
}
