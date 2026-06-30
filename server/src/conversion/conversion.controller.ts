/**
 * ConversionController — pass-through to ConversionService for
 * `/api/v1/conversion/*` plus the ComPDF Web-facing
 * `/api/v1/process/{source}/{target}` facade.
 *
 * Uses ConversionService (NOT the raw client) so the forward-compat truncation
 * headers are parsed. On a truncated result the response carries
 * `X-ComPDF-Pages-Processed` / `X-ComPDF-Pages-Total` / `X-ComPDF-Truncated: true`
 * so the frontend can surface "processed N of M pages". Per R4 the live service
 * does NOT currently truncate (it 422s on page limit); these headers are
 * forward-compat and simply absent today.
 *
 * The license token is read from `req.__licenseToken` (LicensePassthroughInterceptor).
 * ComPDF Web routes — NOT behind JwtAuthGuard.
 *
 * Contract (docs/sdk-contract.md §3): `/v1/convert` takes flat multipart fields
 * `file` + `target` + `options`(JSON) + `password`; `/v1/convert-to-pdf` takes
 * `file` + `type` + `options` + `password`; `/v1/documentai/{op}` takes `file`
 * + `options`.
 */
import {
  BadRequestException,
  Controller,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { ConvertTarget, DocumentAiOperation } from '../clients/conversion.client';
import { ErrorCode } from '../common/errors/error-codes';
import { sanitizeFilename } from '../common/utils/filename';
import { ConversionService } from './conversion.service';

type MulterFile = Express.Multer.File;
type ProcessConversionRoute =
  | { kind: 'target'; value: ConvertTarget }
  | { kind: 'type'; value: string }
  | { kind: 'to-pdf'; value?: string };

const ALLOWED_DOCUMENTAI: ReadonlySet<string> = new Set<DocumentAiOperation>([
  'layout',
  'ocr',
  'table',
  'stamp',
  'magic-color',
  'dewarp',
]);

const PROCESS_CONVERSION_ROUTES: Readonly<Record<string, ProcessConversionRoute>> = {
  'pdf/docx': { kind: 'target', value: 'docx' },
  'pdf/json': { kind: 'target', value: 'json' },
  'pdf/html': { kind: 'target', value: 'html' },
  'pdf/csv': { kind: 'target', value: 'csv' },
  'pdf/xlsx': { kind: 'target', value: 'xlsx' },
  'pdf/txt': { kind: 'target', value: 'txt' },
  'pdf/pptx': { kind: 'target', value: 'pptx' },
  'pdf/png': { kind: 'target', value: 'png' },
  'pdf/rtf': { kind: 'target', value: 'rtf' },
  'pdf/pdf': { kind: 'type', value: 'pdf/pdf' },
  'pdf/ofd': { kind: 'type', value: 'pdf/ofd' },
  'docx/pdf': { kind: 'to-pdf', value: 'docx/pdf' },
  'png/pdf': { kind: 'to-pdf', value: 'png/pdf' },
  'rtf/pdf': { kind: 'to-pdf', value: 'rtf/pdf' },
  'xlsx/pdf': { kind: 'to-pdf', value: 'xlsx/pdf' },
  'txt/pdf': { kind: 'to-pdf', value: 'txt/pdf' },
  'csv/pdf': { kind: 'to-pdf', value: 'csv/pdf' },
  'pptx/pdf': { kind: 'to-pdf', value: 'pptx/pdf' },
  'html/pdf': { kind: 'to-pdf', value: 'html/pdf' },
  'img/docx': { kind: 'type', value: 'img/docx' },
  'img/html': { kind: 'type', value: 'img/html' },
  'img/xlsx': { kind: 'type', value: 'img/xlsx' },
  'img/txt': { kind: 'type', value: 'img/txt' },
  'img/rtf': { kind: 'type', value: 'img/rtf' },
  'img/pptx': { kind: 'type', value: 'img/pptx' },
  'img/json': { kind: 'type', value: 'img/json' },
  'img/csv': { kind: 'type', value: 'img/csv' },
};

/**
 * NOTE: the sync /api/v1/conversion/* routes are NOT behind ApiKeyGuard — the
 * public ComPDF Web SPA calls them with no client key. Only the async
 * /api/v1/task/* routes require x-api-key (for external API clients).
 */
@Controller('api/v1')
export class ConversionController {
  private readonly logger = new Logger(ConversionController.name);

  constructor(private readonly service: ConversionService) {}

  @Post('conversion/convert')
  @UseInterceptors(FileInterceptor('file'))
  async convert(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const target = stringField(req.body, 'target');
    const type = stringField(req.body, 'type');
    if (target && type) {
      throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: 'ambiguous: provide target OR type, not both' });
    }
    if (!target && !type) {
      throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: 'missing required field: target or type' });
    }
    const options = parseOptions(req.body);
    const password = stringField(req.body, 'password');
    this.logger.debug(`conversion convert request ${JSON.stringify({
      route: 'conversion/convert',
      target,
      type,
      file: fileSummary(file),
      options: sanitizeObjectForLog(options),
      passwordPresent: !!password,
    })}`);
    const result = target
      ? await this.service.convert(requireFile(file), target as ConvertTarget, tokenOf(req), options, password)
      : await this.service.convertByType(requireFile(file), type as string, tokenOf(req), options, password);
    this.send(res, result);
  }

  @Post('process/:source/:target')
  @UseInterceptors(FileInterceptor('file'))
  async convertProcess(
    @Param('source') source: string,
    @Param('target') target: string,
    @UploadedFile() file: MulterFile,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const key = `${source}/${target}`;
    const route = PROCESS_CONVERSION_ROUTES[key];
    if (!route) {
      throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: `unsupported process path: ${key}` });
    }
    const options = parseOptions(req.body);
    const password = stringField(req.body, 'password');
    const upload = requireFile(file);
    const token = tokenOf(req);
    this.logger.debug(`conversion process request ${JSON.stringify({
      route: key,
      mode: route.kind,
      target: route.kind === 'target' ? route.value : undefined,
      type: route.kind !== 'target' ? route.value : undefined,
      file: fileSummary(upload),
      options: sanitizeObjectForLog(options),
      passwordPresent: !!password,
    })}`);
    const result = route.kind === 'target'
      ? await this.service.convert(upload, route.value, token, options, password)
      : route.kind === 'type'
        ? await this.service.convertByType(upload, route.value, token, options, password)
        : await this.service.convertToPdf(upload, token, route.value, options, password);
    this.send(res, result);
  }

  @Post('conversion/convert-to-pdf')
  @UseInterceptors(FileInterceptor('file'))
  async convertToPdf(@UploadedFile() file: MulterFile, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.service.convertToPdf(
      requireFile(file),
      tokenOf(req),
      stringField(req.body, 'type'),
      parseOptions(req.body),
      stringField(req.body, 'password'),
    );
    this.send(res, result);
  }

  @Post('conversion/documentai/:operation')
  @UseInterceptors(FileInterceptor('file'))
  async documentAi(
    @Param('operation') operation: string,
    @UploadedFile() file: MulterFile,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!ALLOWED_DOCUMENTAI.has(operation)) {
      throw new BadRequestException({
        code: ErrorCode.BAD_REQUEST,
        message: `unsupported documentai operation: ${operation}`,
      });
    }
    const result = await this.service.documentAi(
      operation as DocumentAiOperation,
      requireFile(file),
      tokenOf(req),
      parseOptions(req.body),
    );
    this.send(res, result);
  }

  // ---- Helpers ------------------------------------------------------------

  /**
   * Stream the conversion result. Echoes the upstream Content-Type (default
   * application/octet-stream per §3.2) and a Content-Disposition built from the
   * parsed filename (or a generic `conversion-result` fallback). When the
   * (forward-compat) truncation signal is present, stamps the X-ComPDF-* headers.
   */
  private send(res: Response, result: import('./conversion.service').ConversionResult): void {
    const contentType = result.contentType ?? 'application/octet-stream';
    const filename = sanitizeFilename(result.filename, 'conversion-result');
    const responseBytes = result.buffer.length;
    const startedAt = Date.now();
    this.logger.debug(`conversion response send ${JSON.stringify({
      filename,
      contentType,
      responseBytes,
      truncated: result.truncated,
      processed: result.processed,
      total: result.total,
    })}`);
    if (typeof res.once === 'function') {
      res.once('finish', () => {
        this.logger.debug(`conversion response finish ${JSON.stringify({
          filename,
          contentType,
          responseBytes,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        })}`);
      });
      res.once('close', () => {
        this.logger.debug(`conversion response close ${JSON.stringify({
          filename,
          contentType,
          responseBytes,
          statusCode: res.statusCode,
          writableEnded: res.writableEnded,
          writableFinished: res.writableFinished,
          durationMs: Date.now() - startedAt,
        })}`);
      });
    }
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    if (result.truncated) {
      res.set('X-ComPDF-Truncated', 'true');
      if (result.processed !== undefined) res.set('X-ComPDF-Pages-Processed', String(result.processed));
      if (result.total !== undefined) res.set('X-ComPDF-Pages-Total', String(result.total));
    }
    res.status(200).send(result.buffer);
  }
}

function tokenOf(req: Request): string {
  return req.__licenseToken ?? '';
}

function requireFile(file: MulterFile | undefined): MulterFile {
  if (!file) {
    throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: 'missing required file field: file' });
  }
  return file;
}

function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>)[field];
  if (typeof v !== 'string' || v === '') return undefined;
  return v;
}

/** Parse the optional `options` JSON-string field into an object, or undefined. */
function parseOptions(body: unknown): Record<string, unknown> | undefined {
  const raw = stringField(body, 'options');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: 'invalid JSON in options field' });
  }
}

function fileSummary(file: MulterFile | undefined): Record<string, unknown> | undefined {
  if (!file) return undefined;
  return {
    originalname: file.originalname,
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
