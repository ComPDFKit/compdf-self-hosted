import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException,
  Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { contentDispositionAttachment } from '../common/utils/filename';
import { CreateBatchDto, RetryBatchItemDto, UploadBatchFileDto } from './batch.dto';
import { BatchService } from './batch.service';

@Controller('api/v1/batches')
@UseGuards(ApiKeyGuard)
export class BatchController {
  constructor(private readonly batches: BatchService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateBatchDto, @Req() req: Request) {
    return this.batches.create(dto, (req as any).apiKeyId ?? null);
  }

  @Post(':batchId/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  async upload(@Param('batchId') batchId: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadBatchFileDto, @Req() req: Request) {
    return this.batches.upload(batchId, file, dto.password, dto.relativePath, (req as any).apiKeyId ?? null);
  }

  @Post(':batchId/commit')
  async commit(@Param('batchId') batchId: string, @Req() req: Request) {
    return this.batches.commit(batchId, (req as any).apiKeyId ?? null);
  }

  @Get(':batchId')
  async get(@Param('batchId') batchId: string, @Req() req: Request) {
    return this.batches.getRequired(batchId, (req as any).apiKeyId ?? null);
  }

  @Post(':batchId/cancel')
  async cancel(@Param('batchId') batchId: string, @Req() req: Request) {
    return this.batches.cancel(batchId, (req as any).apiKeyId ?? null);
  }

  @Post('items/:itemId/retry')
  async retry(@Param('itemId') itemId: string, @Body() dto: RetryBatchItemDto, @Req() req: Request) {
    return this.batches.retry(itemId, dto.password, (req as any).apiKeyId ?? null);
  }

  @Get(':batchId/download')
  async download(@Param('batchId') batchId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.batches.batchDownload(batchId, (req as any).apiKeyId ?? null);
    if (!result) throw new ConflictException({ code: 'TASK_NOT_READY', message: 'batch has no downloadable successful outputs yet' });
    sendFile(res, result);
  }

  @Get('items/:itemId/download')
  async itemDownload(@Param('itemId') itemId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.batches.itemDownload(itemId, (req as any).apiKeyId ?? null);
    if (!result) throw new ConflictException({ code: 'TASK_NOT_READY', message: 'batch item is not ready' });
    sendFile(res, result);
  }

  @Get('items/:itemId/outputs/:outputId/download')
  async outputDownload(@Param('outputId') outputId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.batches.outputDownload(outputId, (req as any).apiKeyId ?? null);
    if (!result) throw new ConflictException({ code: 'TASK_NOT_READY', message: 'batch output is not ready' });
    sendFile(res, result);
  }
}

function sendFile(res: Response, result: { buffer: Buffer; contentType: string; filename: string }): void {
  res.set('Content-Type', result.contentType);
  res.set('Content-Disposition', contentDispositionAttachment(result.filename));
  res.status(200).send(result.buffer);
}
