/**
 * PdfController — thin pass-through to PdfSdkClient for `/api/v1/process/pdf/*`.
 *
 * Contract (docs/sdk-contract.md §2, authoritative): every endpoint is POST
 * multipart with a `request` JSON part + file part(s). The controller does NOT
 * invent SDK field names — it forwards the uploaded file(s) and the parsed
 * `request` object; the client owns multipart field names + paths.
 *
 * ComPDF Web routes are NOT behind JwtAuthGuard.
 *
 * Success = the upstream result file streamed back with its Content-Type and a
 * Content-Disposition (upstream filename preserved, else a per-operation default).
 * Errors throw UpstreamSdkError (PDF-SDK dialect, no errorCode) which the
 * AllExceptionsFilter normalizes.
 */
import {
  BadRequestException,
  Controller,
  Logger,
  Post,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { PdfSdkClient, SdkFileResult } from '../clients/pdf-sdk.client';
import { ErrorCode } from '../common/errors/error-codes';
import { contentDispositionAttachment, normalizeUploadedFilename, parseFilenameFromHeader, sanitizeFilename } from '../common/utils/filename';

type MulterFile = Express.Multer.File;

/**
 * The sync /api/v1/process/pdf/* routes are behind ApiKeyGuard — the ComPDF Web SPA
 * sends the deployment's x-api-key (auto-injected by the server into the SPA).
 * The guard stamps req.apiKeyId for logging/auditing.
 */
@Controller('api/v1/process/pdf')
@UseGuards(ApiKeyGuard)
export class PdfController {
  private readonly logger = new Logger(PdfController.name);

  constructor(private readonly client: PdfSdkClient) {}

  // ---- Pages --------------------------------------------------------------

  @Post('merge')
  @UseInterceptors(FilesInterceptor('files'))
  async merge(@UploadedFiles() files: MulterFile[], @Req() req: Request, @Res() res: Response): Promise<void> {
    const list = requireFiles(files, 'files');
    const request = extractRequest(req.body);
    this.logIncoming('merge', request, list);
    const result = await this.client.merge(list, request, tokenOf(req));
    this.sendFile(res, result, 'merged.pdf');
  }

  @Post('split')
  @UseInterceptors(FileInterceptor('file'))
  async split(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('split', request, [upload]);
    const result = await this.client.split(upload, request, tokenOf(req));
    this.sendFile(res, result, 'split-result.zip');
  }

  @Post('extract')
  @UseInterceptors(FileInterceptor('file'))
  async extract(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('extract', request, [upload]);
    const result = await this.client.extract(upload, request, tokenOf(req));
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
    const request = extractRequest(req.body);
    this.logIncoming('insert-from-pdf', request, [file, insertFile]);
    const result = await this.client.insertFromPdf(file, insertFile, request, tokenOf(req));
    this.sendFile(res, result, 'inserted-pages.pdf');
  }

  @Post('insert-blank')
  @UseInterceptors(FileInterceptor('file'))
  async insertBlank(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('insert-blank', request, [upload]);
    const result = await this.client.insertBlank(upload, request, tokenOf(req));
    this.sendFile(res, result, 'inserted-blank.pdf');
  }

  @Post('delete')
  @UseInterceptors(FileInterceptor('file'))
  async delete(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('delete', request, [upload]);
    const result = await this.client.delete(upload, request, tokenOf(req));
    this.sendFile(res, result, 'deleted-pages.pdf');
  }

  @Post('rotate')
  @UseInterceptors(FileInterceptor('file'))
  async rotate(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('rotate', request, [upload]);
    const result = await this.client.rotate(upload, request, tokenOf(req));
    this.sendFile(res, result, 'rotated.pdf');
  }

  // ---- Security -----------------------------------------------------------

  @Post('encrypt')
  @UseInterceptors(FileInterceptor('file'))
  async encrypt(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('encrypt', request, [upload]);
    const result = await this.client.encrypt(upload, request, tokenOf(req));
    this.sendFile(res, result, 'encrypted.pdf');
  }

  @Post('decrypt')
  @UseInterceptors(FileInterceptor('file'))
  async decrypt(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('decrypt', request, [upload]);
    const result = await this.client.decrypt(upload, request, tokenOf(req));
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
    const request = extractRequest(req.body);
    this.logIncoming('watermark/add', request, imageFile ? [file, imageFile] : [file]);
    const result = await this.client.addWatermark(file, request, tokenOf(req), imageFile);
    this.sendFile(res, result, 'watermarked.pdf');
  }

  @Post('watermark/remove')
  @UseInterceptors(FileInterceptor('file'))
  async removeWatermark(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('watermark/remove', request, [upload]);
    const result = await this.client.removeWatermark(upload, request, tokenOf(req));
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
    const request = extractRequest(req.body);
    this.logIncoming('pdfa', request, [file, iccFile]);
    const result = await this.client.convertStandard(file, iccFile, request, tokenOf(req));
    this.sendFile(res, result, 'standardized.pdf');
  }

  @Post('compress')
  @UseInterceptors(FileInterceptor('file'))
  async compress(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = requireFile(file, 'file');
    const request = extractRequest(req.body);
    this.logIncoming('compress', request, [upload]);
    const result = await this.client.compress(upload, request, tokenOf(req));
    this.sendFile(res, result, 'optimized.pdf');
  }

  // ---- Generation ---------------------------------------------------------

  @Post('generation/html-to-pdf')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'htmlFile', maxCount: 1 }]))
  async htmlToPdf(
    @UploadedFiles() files: { htmlFile?: MulterFile[] },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const request = extractRequest(req.body);
    const htmlFile = files.htmlFile?.[0];
    this.logIncoming('generation/html-to-pdf', request, htmlFile ? [htmlFile] : []);
    const result = await this.client.htmlToPdf(htmlFile, request, tokenOf(req));
    this.sendFile(res, result, 'html-to-pdf.pdf');
  }

  @Post('generation/template-to-pdf')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'templateFile', maxCount: 1 },
      { name: 'dataFile', maxCount: 1 },
    ]),
  )
  async templateToPdf(
    @UploadedFiles() files: { templateFile?: MulterFile[]; dataFile?: MulterFile[] },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const request = extractRequest(req.body);
    const templateFile = files.templateFile?.[0];
    const dataFile = files.dataFile?.[0];
    this.logIncoming('generation/template-to-pdf', request, [templateFile, dataFile].filter(Boolean) as MulterFile[]);
    const result = await this.client.templateToPdf(templateFile, dataFile, request, tokenOf(req));
    this.sendFile(res, result, 'template-to-pdf.pdf');
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
    res.set('Content-Disposition', contentDispositionAttachment(filename));
    res.status(200).send(result.buffer);
  }

  private logIncoming(route: string, request: Record<string, unknown>, files: MulterFile[]): void {
    this.logger.log(`pdf request received ${JSON.stringify({
      route,
      files: files.map(fileSummary),
      request: sanitizeObjectForLog(request),
    })}`);
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

function tokenOf(req: Request): string {
  void req;
  return '';
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

function fileSummary(file: MulterFile): Record<string, unknown> {
  return {
    originalname: normalizeUploadedFilename(file.originalname),
    mimetype: file.mimetype,
    size: file.size ?? file.buffer?.length,
  };
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
