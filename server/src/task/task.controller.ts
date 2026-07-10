/**
 * TaskController — async task lifecycle.
 *
 *   POST /api/v1/task/:source/:target (ApiKeyGuard) → 202 {code:200,msg,data:{taskId,status:"pending"}}
 *   GET  /api/v1/task/:id        (ApiKeyGuard) → 200 {code,msg,data:TaskInfo}, or 404 envelope
 *   GET  /api/v1/task/:id/download (ApiKeyGuard) → file stream (success) / 409 envelope / 404 envelope
 *   POST /api/v1/task/:id/cancel   (ApiKeyGuard) → 200 {code:200,msg,data:TaskInfo}
 *
 * `create` and `get` RETURN their data; the global EnvelopeInterceptor wraps it
 * in `{ code: 200, msg: 'success', data }`. `download` streams a file via
 * `@Res()` (the envelope interceptor passes it through once `headersSent`) and
 * throws ConflictException/NotFoundException on error so AllExceptionsFilter
 * shapes the error envelope.
 *
 * Multipart fields mirror the sync process routes: `files` for merge, `file`
 * otherwise, with operation-specific second files such as `insertFile`.
 * The guard stamps `req.apiKeyId`; this controller owns async lifecycle only.
 */
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode,
  NotFoundException, Param, Post, Req, Res, UploadedFiles, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { contentDispositionAttachment, sanitizeFilename } from '../common/utils/filename';
import { CreateTaskDto } from './task.dto';
import { TaskService } from './task.service';

@Controller('api/v1/task')
@UseGuards(ApiKeyGuard)
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Req() req: Request) {
    const info = await this.tasks.cancel(id, (req as any).apiKeyId ?? null);
    if (!info) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'task not found' });
    }
    return info;
  }

  @Post('pdf/watermark/:action')
  @HttpCode(202)
  @UseInterceptors(taskFileFieldsInterceptor())
  async createPdfWatermarkTask(
    @Param('action') action: string,
    @Body() dto: CreateTaskDto,
    @UploadedFiles() files: TaskUploadFields,
    @Req() req: Request,
  ): Promise<{ taskId: string; status: 'pending' }> {
    return this.create('pdf', `watermark/${action}`, dto, files, req);
  }

  @Post('pdf/generation/:operation')
  @HttpCode(202)
  @UseInterceptors(taskFileFieldsInterceptor())
  async createPdfGenerationTask(
    @Param('operation') operation: string,
    @Body() dto: CreateTaskDto,
    @UploadedFiles() files: TaskUploadFields,
    @Req() req: Request,
  ): Promise<{ taskId: string; status: 'pending' }> {
    return this.create('pdf', `generation/${operation}`, dto, files, req);
  }

  @Post(':source/:target')
  @HttpCode(202)
  @UseInterceptors(taskFileFieldsInterceptor())
  async create(
    @Param('source') source: string,
    @Param('target') target: string,
    @Body() dto: CreateTaskDto,
    @UploadedFiles() files: TaskUploadFields,
    @Req() req: Request,
  ): Promise<{ taskId: string; status: 'pending' }> {
    const taskDto = createTaskDtoFromPath(source, target, dto);
    const orderedFiles = collectTaskFiles(taskDto, files);
    const { taskId } = await this.tasks.create(taskDto, orderedFiles, (req as any).apiKeyId ?? null);
    return { taskId, status: 'pending' };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request) {
    const info = await this.tasks.get(id, (req as any).apiKeyId ?? null);
    if (!info) {
      // Thrown HttpException → AllExceptionsFilter shapes the error envelope.
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'task not found' });
    }
    return info;
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    // Try the result file first. On success we can stream immediately and skip a
    // DB round-trip; when no result is available we consult get() to distinguish
    // a missing task (404) from a task that exists but isn't ready (409).
    const apiKeyId = (req as any).apiKeyId ?? null;
    const d = await this.tasks.download(id, apiKeyId);
    if (d) {
      const filename = sanitizeFilename(d.filename, 'task-result');
      res.set('Content-Type', d.contentType);
      res.set('Content-Disposition', contentDispositionAttachment(filename));
      res.status(200).send(d.buffer);
      return;
    }
    const info = await this.tasks.get(id, apiKeyId);
    if (!info) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'task not found' });
    }
    // 409 → ConflictException → AllExceptionsFilter envelopes it as
    // { code: 'TASK_NOT_READY', msg, data: null }.
    throw new ConflictException({ code: 'TASK_NOT_READY', message: `task status is ${info.status}` });
  }
}

type TaskUploadFields = {
  file?: Express.Multer.File[];
  files?: Express.Multer.File[];
  insertFile?: Express.Multer.File[];
  imageFile?: Express.Multer.File[];
  iccFile?: Express.Multer.File[];
  htmlFile?: Express.Multer.File[];
  templateFile?: Express.Multer.File[];
  dataFile?: Express.Multer.File[];
};

function taskFileFieldsInterceptor() {
  return FileFieldsInterceptor([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: 10 },
    { name: 'insertFile', maxCount: 1 },
    { name: 'imageFile', maxCount: 1 },
    { name: 'iccFile', maxCount: 1 },
    { name: 'htmlFile', maxCount: 1 },
    { name: 'templateFile', maxCount: 1 },
    { name: 'dataFile', maxCount: 1 },
  ], { limits: { fileSize: 100 * 1024 * 1024 } });
}

function collectTaskFiles(dto: CreateTaskDto, files: TaskUploadFields | undefined): Express.Multer.File[] {
  if (dto.kind === 'pdf' && dto.op === 'merge') {
    const list = files?.files ?? [];
    if (list.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'missing required file field: files' });
    }
    return list;
  }

  if (dto.kind === 'pdf' && dto.op === 'generation/html-to-pdf') {
    const htmlFile = files?.htmlFile?.[0];
    if (htmlFile) return [htmlFile];
    if (dto.request) return [];
    throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'missing required file field: htmlFile' });
  }
  if (dto.kind === 'pdf' && dto.op === 'generation/template-to-pdf') {
    const generationFiles: Express.Multer.File[] = [];
    if (files?.templateFile?.[0]) generationFiles.push(files.templateFile[0]);
    if (files?.dataFile?.[0]) generationFiles.push(files.dataFile[0]);
    if (generationFiles.length > 0 || dto.request) return generationFiles;
    throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'missing required file field: templateFile' });
  }

  const primary = files?.file?.[0];
  if (!primary) {
    throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'missing required file field: file' });
  }
  const list = [primary];
  if (dto.kind === 'pdf' && dto.op === 'insert-from-pdf') {
    const insertFile = files?.insertFile?.[0];
    if (!insertFile) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'missing required file field: insertFile' });
    }
    list.push(insertFile);
  }
  if (dto.kind === 'pdf' && dto.op === 'watermark/add' && files?.imageFile?.[0]) {
    list.push(files.imageFile[0]);
  }
  if (dto.kind === 'pdf' && dto.op === 'pdfa') {
    const iccFile = files?.iccFile?.[0];
    if (!iccFile) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'missing required file field: iccFile' });
    }
    list.push(iccFile);
  }
  return list;
}

function createTaskDtoFromPath(source: string, target: string, body: CreateTaskDto): CreateTaskDto {
  const key = `${source}/${target}`;
  if (source === 'pdf' && PDF_TASK_OPS.has(target)) {
    return {
      ...body,
      kind: 'pdf',
      op: target,
      request: body.request,
    };
  }
  const conversion = TASK_CONVERSION_ROUTES[key];
  if (conversion) {
    return { ...body, ...conversion };
  }
  throw new BadRequestException({ code: 'BAD_REQUEST', message: `unsupported task path: ${key}` });
}

const PDF_TASK_OPS = new Set([
  'merge',
  'split',
  'extract',
  'insert-from-pdf',
  'insert-blank',
  'delete',
  'rotate',
  'encrypt',
  'decrypt',
  'watermark/add',
  'watermark/remove',
  'pdfa',
  'compress',
  'generation/html-to-pdf',
  'generation/template-to-pdf',
]);

const TASK_CONVERSION_ROUTES: Readonly<Record<string, CreateTaskDto>> = {
  'pdf/docx': { kind: 'conversion', op: 'convert', target: 'docx' },
  'pdf/json': { kind: 'conversion', op: 'convert', target: 'json' },
  'pdf/html': { kind: 'conversion', op: 'convert', target: 'html' },
  'pdf/csv': { kind: 'conversion', op: 'convert', target: 'csv' },
  'pdf/xlsx': { kind: 'conversion', op: 'convert', target: 'xlsx' },
  'pdf/txt': { kind: 'conversion', op: 'convert', target: 'txt' },
  'pdf/pptx': { kind: 'conversion', op: 'convert', target: 'pptx' },
  'pdf/png': { kind: 'conversion', op: 'convert', target: 'png' },
  'pdf/rtf': { kind: 'conversion', op: 'convert', target: 'rtf' },
  'pdf/pdf': { kind: 'conversion', op: 'convert', type: 'pdf/pdf' },
  'pdf/ofd': { kind: 'conversion', op: 'convert', type: 'pdf/ofd' },
  'docx/pdf': { kind: 'conversion', op: 'convert-to-pdf', type: 'docx/pdf' },
  'png/pdf': { kind: 'conversion', op: 'convert-to-pdf', type: 'png/pdf' },
  'rtf/pdf': { kind: 'conversion', op: 'convert-to-pdf', type: 'rtf/pdf' },
  'xlsx/pdf': { kind: 'conversion', op: 'convert-to-pdf', type: 'xlsx/pdf' },
  'txt/pdf': { kind: 'conversion', op: 'convert-to-pdf', type: 'txt/pdf' },
  'csv/pdf': { kind: 'conversion', op: 'convert-to-pdf', type: 'csv/pdf' },
  'pptx/pdf': { kind: 'conversion', op: 'convert-to-pdf', type: 'pptx/pdf' },
  'html/pdf': { kind: 'conversion', op: 'convert-to-pdf', type: 'html/pdf' },
  'img/docx': { kind: 'conversion', op: 'convert', type: 'img/docx' },
  'img/html': { kind: 'conversion', op: 'convert', type: 'img/html' },
  'img/xlsx': { kind: 'conversion', op: 'convert', type: 'img/xlsx' },
  'img/txt': { kind: 'conversion', op: 'convert', type: 'img/txt' },
  'img/rtf': { kind: 'conversion', op: 'convert', type: 'img/rtf' },
  'img/pptx': { kind: 'conversion', op: 'convert', type: 'img/pptx' },
  'img/json': { kind: 'conversion', op: 'convert', type: 'img/json' },
  'img/csv': { kind: 'conversion', op: 'convert', type: 'img/csv' },
};
