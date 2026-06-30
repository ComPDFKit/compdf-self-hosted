/**
 * PdfController — thin pass-through to PdfSdkClient for `/api/v1/pdf/*`.
 *
 * Contract (docs/sdk-contract.md §2, authoritative): every endpoint is POST
 * multipart with a `request` JSON part + file part(s). The controller does NOT
 * invent SDK field names — it forwards the uploaded file(s) and the parsed
 * `request` object; the client owns multipart field names + paths.
 *
 * The license token is read from `req.__licenseToken` (stamped by the global
 * LicensePassthroughInterceptor) — NEVER from the body or env. ComPDF Web routes
 * are NOT behind JwtAuthGuard.
 *
 * Success = the upstream result file streamed back with its Content-Type and a
 * Content-Disposition (upstream filename preserved, else a per-operation default).
 * Errors throw UpstreamSdkError (PDF-SDK dialect, no errorCode) which the
 * AllExceptionsFilter normalizes.
 */
import {
  BadRequestException,
  Controller,
  Post,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { PdfSdkClient, SdkFileResult } from '../clients/pdf-sdk.client';
import { ErrorCode } from '../common/errors/error-codes';
import { parseFilenameFromHeader, sanitizeFilename } from '../common/utils/filename';

type MulterFile = Express.Multer.File;

/**
 * NOTE: the sync /api/v1/pdf/* routes are NOT behind ApiKeyGuard — the public
 * ComPDF Web SPA calls them with no client key. Only the async /api/v1/task/*
 * routes require x-api-key (for external API clients). License gating stays
 * sunk-down (X-ComPDF-License attached upstream by the clients).
 */
@Controller('api/v1/pdf')
export class PdfController {
  constructor(private readonly client: PdfSdkClient) {}

  // ---- Pages --------------------------------------------------------------

  @Post('merge')
  @UseInterceptors(FilesInterceptor('files'))
  async merge(@UploadedFiles() files: MulterFile[], @Req() req: Request, @Res() res: Response): Promise<void> {
    const list = requireFiles(files, 'files');
    const result = await this.client.merge(list, extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'merged.pdf');
  }

  @Post('split')
  @UseInterceptors(FileInterceptor('file'))
  async split(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.split(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'split-result.zip');
  }

  @Post('extract')
  @UseInterceptors(FileInterceptor('file'))
  async extract(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.extract(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'extracted.pdf');
  }

  @Post('insert-from-pdf')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'file', maxCount: 1 },
      { name: 'insertFile', maxCount: 1 },
    ]),
  )
  async insertFromPdf(
    @UploadedFiles() files: { file?: MulterFile[]; insertFile?: MulterFile[] },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const file = requireFile(files.file?.[0], 'file');
    const insertFile = requireFile(files.insertFile?.[0], 'insertFile');
    const result = await this.client.insertFromPdf(file, insertFile, extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'inserted-pages.pdf');
  }

  @Post('insert-blank')
  @UseInterceptors(FileInterceptor('file'))
  async insertBlank(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.insertBlank(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'inserted-blank.pdf');
  }

  @Post('delete')
  @UseInterceptors(FileInterceptor('file'))
  async delete(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.delete(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'deleted-pages.pdf');
  }

  @Post('rotate')
  @UseInterceptors(FileInterceptor('file'))
  async rotate(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.rotate(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'rotated.pdf');
  }

  // ---- Security -----------------------------------------------------------

  @Post('encrypt')
  @UseInterceptors(FileInterceptor('file'))
  async encrypt(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.encrypt(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'encrypted.pdf');
  }

  @Post('decrypt')
  @UseInterceptors(FileInterceptor('file'))
  async decrypt(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.decrypt(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'decrypted.pdf');
  }

  // ---- Watermarks ---------------------------------------------------------

  @Post('watermark/add')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'file', maxCount: 1 },
      { name: 'imageFile', maxCount: 1 },
    ]),
  )
  async addWatermark(
    @UploadedFiles() files: { file?: MulterFile[]; imageFile?: MulterFile[] },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const file = requireFile(files.file?.[0], 'file');
    const imageFile = files.imageFile?.[0]; // optional — present only for type=image
    const result = await this.client.addWatermark(file, extractRequest(req.body), tokenOf(req), imageFile);
    this.sendFile(res, result, 'watermarked.pdf');
  }

  @Post('watermark/remove')
  @UseInterceptors(FileInterceptor('file'))
  async removeWatermark(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.removeWatermark(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'watermark-removed.pdf');
  }

  // ---- Standards / Optimize ----------------------------------------------

  @Post('pdfa')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'file', maxCount: 1 },
      { name: 'iccFile', maxCount: 1 },
    ]),
  )
  async pdfa(
    @UploadedFiles() files: { file?: MulterFile[]; iccFile?: MulterFile[] },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const file = requireFile(files.file?.[0], 'file');
    const iccFile = requireFile(files.iccFile?.[0], 'iccFile');
    // PDF/A, PDF/X, PDF/E, PDF/UA — the SDK's standards/convert endpoint.
    const result = await this.client.convertStandard(file, iccFile, extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'standardized.pdf');
  }

  @Post('compress')
  @UseInterceptors(FileInterceptor('file'))
  async compress(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.client.compress(requireFile(file, 'file'), extractRequest(req.body), tokenOf(req));
    this.sendFile(res, result, 'optimized.pdf');
  }

  // ---- Helpers ------------------------------------------------------------

  /**
   * Stream the upstream result file back. Preserves the upstream Content-Type
   * but NEVER trusts the upstream Content-Disposition verbatim (a compromised
   * or MITM upstream could inject CRLF / extra headers / path traversal). The
   * filename is parsed out of the upstream header, sanitized, and rebuilt as
   * `attachment; filename="<safe>"`; when the upstream omits a filename, the
   * per-operation `defaultFilename` is used. Uses the raw express Response so
   * binary bytes are sent verbatim (no JSON serialization).
   */
  private sendFile(res: Response, result: SdkFileResult, defaultFilename: string): void {
    const contentType = result.headers['content-type'] ?? 'application/octet-stream';
    const filename = sanitizeFilename(
      parseFilenameFromHeader(result.headers['content-disposition']),
      defaultFilename,
    );
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(result.buffer);
  }
}

/**
 * Pull the structured `request` object off a multer-parsed body. The frontend
 * sends the SDK params as a `request` JSON-string field; if absent, the
 * remaining text fields are forwarded as the request object (multer has already
 * separated file parts). The client then JSON.stringifies this into the SDK's
 * `request` part. The controller does NOT know SDK field names.
 */
function extractRequest(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const r = b.request;
  if (typeof r === 'string' && r.trim() !== '') {
    try {
      const parsed = JSON.parse(r);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* fall through to field-forwarding */
    }
  }
  if (r && typeof r === 'object') return r as Record<string, unknown>;
  const rest: Record<string, unknown> = { ...b };
  delete rest.request;
  return rest;
}

/** Read the passthrough license token (stamped by LicensePassthroughInterceptor). */
function tokenOf(req: Request): string {
  return req.__licenseToken ?? '';
}

function requireFile(file: MulterFile | undefined, field: string): MulterFile {
  if (!file) {
    throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: `missing required file field: ${field}` });
  }
  return file;
}

function requireFiles(files: MulterFile[] | undefined, field: string): MulterFile[] {
  if (!files || files.length === 0) {
    throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: `missing required file field: ${field}` });
  }
  return files;
}
