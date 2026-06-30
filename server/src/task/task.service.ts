/**
 * TaskService — async task lifecycle for /api/v1/task/*.
 *
 * Async wraps the SAME sync service calls (PdfSdkClient / ConversionService)
 * and writes the result FILE to disk at <storageDir>/<taskId>.bin; the `tasks`
 * table stores only the path (result_path), NOT the BLOB. It does NOT use the
 * engine's own /v1/jobs flow (different shape; double integration surface).
 *
 * create() inserts a `pending` row and kicks runTask() WITHOUT awaiting it
 * (fire-and-forget) so the HTTP response returns immediately with the taskId.
 * runTask() sets `processing`, calls the op, writes the result file + records
 * result_path + `success`, or `failed` + reason. No license/limit logic — the
 * token is read only to pass upstream via the clients (X-ComPDF-License).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { MysqlClient } from '../clients/mysql.client';
import { PdfSdkClient, SdkFileResult } from '../clients/pdf-sdk.client';
import { ConversionService, ConversionResult } from '../conversion/conversion.service';
import { LicenseTokenService } from '../license/license-token.service';
import { sanitizeFilename } from '../common/utils/filename';
import { CreateTaskDto } from './task.dto';
// The optional storageDir parameter lets tests avoid writing task results into
// the runtime storage path.

export interface TaskInfo {
  taskId: string;
  status: 'pending' | 'processing' | 'success' | 'failed';
  fileName?: string;
  downFileName?: string;
  fileSize?: number;
  convertSize?: number;
  convertTime?: number;
  failureCode?: string;
  failureReason?: string;
}

export interface TaskDownload {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

interface TaskRow {
  task_id: string;
  kind: string;
  op: string;
  status: string;
  file_name?: string;
  down_file_name?: string;
  file_size?: number;
  convert_size?: number;
  convert_time_ms?: number;
  failure_code?: string;
  failure_reason?: string;
  result_path?: string | null;
  result_content_type?: string;
  request?: string;
  target?: string;
  type?: string;
  operation?: string;
  options?: string;
  password?: string;
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);
  private readonly storageDir: string;

  constructor(
    private readonly mysql: MysqlClient,
    private readonly pdfSdk: PdfSdkClient,
    private readonly conv: ConversionService,
    private readonly license: LicenseTokenService,
    config: ConfigService,
    @Optional() storageDir?: string,
  ) {
    // Test path: inject storageDir positionally (overrides config). Production:
    // NestJS injects ConfigService; storageDir resolves from config 'storageDir'.
    this.storageDir = storageDir ?? config.get<string>('storageDir') ?? 'storage';
  }

  /** Resolve the on-disk path for a task's result file. */
  private resultPath(taskId: string): string {
    return join(this.storageDir, `${taskId}.bin`);
  }

  async create(dto: CreateTaskDto, files: Express.Multer.File[], apiKeyId: string | null): Promise<{ taskId: string }> {
    const taskId = randomUUID();
    const fileName = files[0]?.originalname ?? null;
    const fileSize = files[0]?.buffer?.length ?? null;
    await this.mysql.query(
      `INSERT INTO tasks (task_id, api_key_id, kind, op, status, file_name, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [taskId, apiKeyId, dto.kind, dto.op, 'pending', fileName, fileSize],
    );
    // Fire-and-forget; do NOT await. Errors are caught inside runTask.
    this.runTask(taskId, dto, files).catch((err) =>
      this.logger.error(`runTask crashed for ${taskId}: ${(err as Error).message}`),
    );
    return { taskId };
  }

  async get(taskId: string, apiKeyId: string | null): Promise<TaskInfo | null> {
    // Scope by api_key_id so a client cannot read another client's task (IDOR).
    // When apiKeyId is null (shouldn't happen behind the guard) `api_key_id = NULL`
    // matches nothing and the query returns null, which is the safe default.
    const rows = await this.mysql.query<TaskRow[]>(
      `SELECT task_id, status, file_name, down_file_name, file_size, convert_size,
              convert_time_ms, failure_code, failure_reason
       FROM tasks WHERE task_id = ? AND api_key_id = ? LIMIT 1`,
      [taskId, apiKeyId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      taskId: r.task_id,
      status: r.status as TaskInfo['status'],
      fileName: r.file_name ?? undefined,
      downFileName: r.down_file_name ?? undefined,
      fileSize: r.file_size ?? undefined,
      convertSize: r.convert_size ?? undefined,
      convertTime: r.convert_time_ms ?? undefined,
      failureCode: r.failure_code ?? undefined,
      failureReason: r.failure_reason ?? undefined,
    };
  }

  async download(taskId: string, apiKeyId: string | null): Promise<TaskDownload | null> {
    // Scope by api_key_id (same IDOR protection as get()).
    const rows = await this.mysql.query<TaskRow[]>(
      `SELECT status, result_path, result_content_type, down_file_name
       FROM tasks WHERE task_id = ? AND api_key_id = ? LIMIT 1`,
      [taskId, apiKeyId],
    );
    const r = rows[0];
    if (!r || r.status !== 'success' || !r.result_path) return null;
    const buffer = await readFile(r.result_path);
    return {
      buffer,
      contentType: r.result_content_type ?? 'application/octet-stream',
      filename: sanitizeFilename(r.down_file_name, `${taskId}-result`),
    };
  }

  async runTask(taskId: string, dto: CreateTaskDto, files: Express.Multer.File[]): Promise<void> {
    const startedAt = Date.now();
    await this.mysql.query(`UPDATE tasks SET status = 'processing' WHERE task_id = ?`, [taskId]);
    try {
      const result = await this.dispatch(dto, files);
      const buffer = bufferOf(result);
      const contentType = contentTypeOf(result);
      const filename = sanitizeFilename(filenameOf(result, dto, files), `${dto.op}-result`);
      // Ensure the storage dir exists, then write the result file to disk.
      await mkdir(this.storageDir, { recursive: true });
      const path = this.resultPath(taskId);
      await writeFile(path, buffer);
      await this.mysql.query(
        `UPDATE tasks SET status = 'success', result_path = ?, result_content_type = ?,
                          down_file_name = ?, convert_size = ?, convert_time_ms = ? WHERE task_id = ?`,
        [path, contentType, filename, buffer.length, Date.now() - startedAt, taskId],
      );
    } catch (err) {
      const e = err as Error;
      this.logger.warn(`task ${taskId} failed: ${e.message}`);
      await this.mysql.query(
        `UPDATE tasks SET status = 'failed', failure_code = ?, failure_reason = ? WHERE task_id = ?`,
        ['TASK_ERROR', e.message.slice(0, 1000), taskId],
      );
    }
  }

  /** Route the dto to the right sync service call. */
  private async dispatch(dto: CreateTaskDto, files: Express.Multer.File[]): Promise<SdkFileResult | ConversionResult> {
    // insert-from-pdf and pdfa consume files[1]; reject early with a clear
    // failure_reason instead of an opaque TypeError (caught by runTask → failed).
    if ((dto.op === 'insert-from-pdf' || dto.op === 'pdfa') && (!files || files.length < 2)) {
      throw new Error('this operation requires two files');
    }
    const token = this.license.getRawToken();
    const requestObj = dto.request ? safeJson(dto.request) : {};
    const options = dto.options ? safeJson(dto.options) : undefined;
    const file = files[0];
    if (dto.kind === 'pdf') {
      switch (dto.op) {
        case 'merge': return this.pdfSdk.merge(files, requestObj, token);
        case 'split': return this.pdfSdk.split(file, requestObj, token);
        case 'extract': return this.pdfSdk.extract(file, requestObj, token);
        case 'insert-from-pdf': return this.pdfSdk.insertFromPdf(file, files[1], requestObj, token);
        case 'insert-blank': return this.pdfSdk.insertBlank(file, requestObj, token);
        case 'delete': return this.pdfSdk.delete(file, requestObj, token);
        case 'rotate': return this.pdfSdk.rotate(file, requestObj, token);
        case 'encrypt': return this.pdfSdk.encrypt(file, requestObj, token);
        case 'decrypt': return this.pdfSdk.decrypt(file, requestObj, token);
        case 'watermark/add': return this.pdfSdk.addWatermark(file, requestObj, token, files[1]);
        case 'watermark/remove': return this.pdfSdk.removeWatermark(file, requestObj, token);
        case 'pdfa': return this.pdfSdk.convertStandard(file, files[1], requestObj, token);
        case 'compress': return this.pdfSdk.compress(file, requestObj, token);
        default: throw new Error(`unsupported pdf op: ${dto.op}`);
      }
    }
    // kind === 'conversion'
    switch (dto.op) {
      case 'convert':
        if (dto.type) return this.conv.convertByType(file, dto.type, token, options, dto.password);
        if (dto.target) return this.conv.convert(file, dto.target as any, token, options, dto.password);
        throw new Error('convert requires target or type');
      case 'convert-to-pdf': return this.conv.convertToPdf(file, token, dto.type, options, dto.password);
      case 'documentai': return this.conv.documentAi(dto.operation as any, file, token, options);
      default: throw new Error(`unsupported conversion op: ${dto.op}`);
    }
  }
}

function safeJson(s: string): Record<string, unknown> {
  try { const p = JSON.parse(s); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}

function bufferOf(r: SdkFileResult | ConversionResult): Buffer {
  return (r as SdkFileResult).buffer ?? (r as ConversionResult).buffer;
}
function contentTypeOf(r: SdkFileResult | ConversionResult): string {
  const c = (r as SdkFileResult).headers?.['content-type'] ?? (r as ConversionResult).contentType;
  return c ?? 'application/octet-stream';
}
function filenameOf(r: SdkFileResult | ConversionResult, dto: CreateTaskDto, files: Express.Multer.File[]): string | undefined {
  const cd = (r as SdkFileResult).headers?.['content-disposition'];
  if (cd) {
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) return decodeURIComponent(m[1]);
  }
  // ConversionResult has no headers but carries the upstream-suggested filename
  // (parsed from Content-Disposition by ConversionService). Prefer it before
  // falling back to the source file's originalname — mirrors the sync
  // ConversionController.send, which uses result.filename directly.
  const f = (r as ConversionResult).filename;
  if (f) return f;
  return files[0]?.originalname;
}
