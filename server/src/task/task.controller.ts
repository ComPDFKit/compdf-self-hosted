/**
 * TaskController — async task lifecycle (ComPDF-online-API-style envelopes).
 *
 *   POST /api/v1/task            (ApiKeyGuard) → 202 {code,msg,data:{taskId,status:"pending"}}
 *   GET  /api/v1/task/:id        (ApiKeyGuard) → 200 envelope, or 404 {code:"NOT_FOUND"}
 *   GET  /api/v1/task/:id/download (ApiKeyGuard) → file stream (success) / 409 (not ready) / 404 (missing)
 *
 * Multipart: `files[]` for merge, `file` otherwise, plus `kind`/`op`/`target`/`type`/...
 * The guard stamps `req.apiKeyId`. Sync routes (pdf/conversion) are unchanged
 * (direct stream); this controller only owns the async lifecycle.
 */
import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, Res,
  UploadedFiles, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { sanitizeFilename } from '../common/utils/filename';
import { CreateTaskDto } from './task.dto';
import { TaskService } from './task.service';

@Controller('api/v1/task')
@UseGuards(ApiKeyGuard)
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Post()
  @UseInterceptors(
    // `files[]` covers both merge (multi) and single-file (file). Limits mirror
    // PdfModule/ConversionModule: 100 MB per file (limits.fileSize) + a 10-file
    // cap (maxCount, enforced by multer's array field-count limit).
    FilesInterceptor('files', 10, { limits: { fileSize: 100 * 1024 * 1024 } }),
  )
  async create(
    @Body() dto: CreateTaskDto,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // dto is validated by the global ValidationPipe (whitelist + transform in
    // AppModule): @IsIn(['pdf','conversion']) on kind, @IsString() on op, etc.
    if (!files || files.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'missing required file field: files' });
    }
    const { taskId } = await this.tasks.create(dto, files, (req as any).apiKeyId ?? null);
    res.status(202).json({ code: '200', msg: 'success', data: { taskId, status: 'pending' } });
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const info = await this.tasks.get(id, (req as any).apiKeyId ?? null);
    if (!info) {
      // Thrown HttpException → AllExceptionsFilter.normalizeHttp surfaces the
      // { code, message } payload as { code: 'NOT_FOUND', message: '...' }.
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'task not found' });
    }
    res.status(200).json({ code: '200', msg: 'success', data: info });
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
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.status(200).send(d.buffer);
      return;
    }
    const info = await this.tasks.get(id, apiKeyId);
    if (!info) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'task not found' });
    }
    // 409 has no mapping in AllExceptionsFilter.httpCodeFor, so write directly.
    // Use `message` (not `msg`) to match the filter's error-envelope shape.
    res.status(409).json({ code: 'TASK_NOT_READY', message: `task status is ${info.status}` });
  }
}
