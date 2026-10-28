import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { createWriteStream, existsSync } from 'fs';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import archiver = require('archiver');
import { unzipSync } from 'fflate';
import { MysqlClient, MysqlTransaction } from '../clients/mysql.client';
import { PdfSdkClient, SdkFileResult, MulterFile } from '../clients/pdf-sdk.client';
import { ConversionResult, ConversionService } from '../conversion/conversion.service';
import { ErrorCode } from '../common/errors/error-codes';
import { UpstreamSdkError } from '../common/errors/upstream-sdk.error';
import { normalizeUploadedFilename, parseFilenameFromHeader, sanitizeFilename } from '../common/utils/filename';
import { BatchKind, CreateBatchDto } from './batch.dto';
import { PDF_DECORATION_OPS, validateDecorationRequest } from '../pdf/decoration-validation';
import { validateEncryptRequest } from '../pdf/encryption-validation';

export type BatchStatus = 'draft' | 'queued' | 'processing' | 'success' | 'partial_success' | 'failed' | 'canceled';
export type BatchItemStatus = 'uploaded' | 'queued' | 'processing' | 'success' | 'failed' | 'canceled';

export interface BatchItemInfo {
  itemId: string;
  sequenceNo: number;
  sourceName: string;
  sourceSize: number;
  status: BatchItemStatus;
  attemptCount: number;
  outputName?: string;
  outputSize?: number;
  failureCode?: string;
  failureReason?: string;
  downloadUrl?: string;
  relativePath?: string;
  outputs?: BatchOutputInfo[];
}

export interface BatchOutputInfo {
  outputId: string;
  sequenceNo: number;
  name: string;
  size: number;
  contentType: string;
  downloadUrl: string;
}

export interface BatchInfo {
  batchId: string;
  kind: BatchKind;
  op: string;
  target?: string;
  type?: string;
  operation?: string;
  status: BatchStatus;
  totalCount: number;
  queuedCount: number;
  processingCount: number;
  successCount: number;
  failedCount: number;
  canceledCount: number;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  downloadUrl?: string;
  items: BatchItemInfo[];
}

export interface BatchDownload {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

interface BatchRow {
  batch_id: string;
  kind: BatchKind;
  op: string;
  target?: string | null;
  type?: string | null;
  operation?: string | null;
  status: BatchStatus;
  total_count: number | string;
  queued_count: number | string;
  processing_count: number | string;
  success_count: number | string;
  failed_count: number | string;
  canceled_count: number | string;
  request_json?: string | Record<string, unknown> | null;
  options_json?: string | Record<string, unknown> | null;
  output_passwords_ciphertext?: string | null;
  archive_path?: string | null;
  created_at?: Date | string;
  started_at?: Date | string | null;
  finished_at?: Date | string | null;
}

interface ItemRow {
  item_id: string;
  batch_id: string;
  sequence_no: number | string;
  source_name: string;
  relative_path?: string | null;
  source_path: string;
  source_size: number | string;
  source_password_ciphertext?: string | null;
  status: BatchItemStatus;
  attempt_count: number | string;
  lease_owner?: string | null;
  output_path?: string | null;
  output_name?: string | null;
  output_content_type?: string | null;
  output_size?: number | string | null;
  failure_code?: string | null;
  failure_reason?: string | null;
}

interface OutputRow {
  output_id: string;
  item_id: string;
  output_sequence: number | string;
  output_name: string;
  output_path: string;
  output_content_type: string;
  output_size: number | string;
}

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const LEASE_MS = 10 * 60 * 1000;
export const BATCH_PDF_OPERATIONS = ['split', 'extract', 'insert-blank', 'delete', 'rotate', 'encrypt', 'decrypt', 'watermark/add', 'watermark/remove', 'headers-footers/add', 'headers-footers/remove', 'bates/add', 'bates/remove', 'compress', 'generation/html-to-pdf'] as const;
export const BATCH_CONVERSION_OPERATIONS = ['convert', 'convert-to-pdf', 'documentai'] as const;
const SUPPORTED_PDF_OPS = new Set<string>(BATCH_PDF_OPERATIONS);
const SUPPORTED_CONVERSION_OPS = new Set<string>(BATCH_CONVERSION_OPERATIONS);

@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);
  private readonly storageDir: string;
  private readonly secret: Buffer;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;

  constructor(
    private readonly mysql: MysqlClient,
    private readonly pdfSdk: PdfSdkClient,
    private readonly conv: ConversionService,
    config: ConfigService,
  ) {
    this.storageDir = config.get<string>('storageDir') ?? 'storage';
    const secret = config.get<string>('jwt.secret') ?? 'compdf-batch-secret';
    this.secret = createHash('sha256').update(secret).digest();
    this.maxFiles = config.get<number>('batch.maxFiles') ?? 100;
    this.maxTotalBytes = config.get<number>('batch.maxTotalBytes') ?? 1024 * 1024 * 1024;
    this.maxFileBytes = Math.min(config.get<number>('batch.maxFileBytes') ?? DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
    this.retentionDays = config.get<number>('batch.retentionDays') ?? 7;
  }

  async create(dto: CreateBatchDto, apiKeyId: string | null): Promise<BatchInfo> {
    this.validateOperation(dto.kind, dto.op);
    const allowedPasswords = dto.kind === 'pdf' && dto.op === 'encrypt' ? ['userPassword', 'ownerPassword'] : [];
    if (hasPasswordField(dto.request, allowedPasswords) || hasPasswordField(dto.options)) {
      throw new BadRequestException({ code: ErrorCode.INVALID_ARGUMENT, message: 'password must be supplied with each uploaded file' });
    }
    const request = { ...dto.request };
    const outputPasswords: Record<string, string> = {};
    if (allowedPasswords.length) {
      validateEncryptRequest(request);
      for (const field of allowedPasswords) {
        const value = request[field];
        if (value === undefined) continue;
        if (typeof value !== 'string' || value.length > 512) {
          throw new BadRequestException({ code: ErrorCode.INVALID_ARGUMENT, message: `${field} must be a string of at most 512 characters` });
        }
        outputPasswords[field] = value;
        delete request[field];
      }
    }
    if (dto.kind === 'pdf') {
      validateDecorationRequest(dto.op, dto.request ?? {});
      if (dto.op === 'bates/add' && dto.options?.numberingMode !== 'per-file') {
        throw new BadRequestException({ code: ErrorCode.UNSUPPORTED_OPERATION, message: 'batch Bates requires options.numberingMode=per-file; continuous numbering is not supported without PDF page inspection' });
      }
    }
    if (dto.idempotencyKey) {
      const existing = await this.mysql.query<BatchRow[]>(
        `SELECT * FROM batches WHERE api_key_id = ? AND idempotency_key = ? LIMIT 1`,
        [apiKeyId, dto.idempotencyKey],
      );
      if (existing[0]) return this.toInfo(existing[0], []);
    }
    const batchId = randomUUID();
    await this.mysql.execute(
      `INSERT INTO batches (batch_id, api_key_id, kind, op, target, type, operation, request_json, options_json, output_passwords_ciphertext, status, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      [batchId, apiKeyId, dto.kind, dto.op, dto.target ?? null, dto.type ?? null, dto.operation ?? null,
        JSON.stringify(request), JSON.stringify(dto.options ?? {}), Object.keys(outputPasswords).length ? this.encrypt(JSON.stringify(outputPasswords)) : null, dto.idempotencyKey ?? null],
    );
    return this.getRequired(batchId, apiKeyId);
  }

  async upload(batchId: string, file: Express.Multer.File | undefined, password: string | undefined, relativePath: string | undefined, apiKeyId: string | null): Promise<BatchItemInfo> {
    if (!file?.buffer?.length) throw new BadRequestException({ code: ErrorCode.FILE_REQUIRED, message: 'file is required' });
    if (file.buffer.length > this.maxFileBytes) throw new BadRequestException({ code: ErrorCode.FILE_TOO_LARGE, message: `file exceeds ${Math.floor(this.maxFileBytes / 1024 / 1024)} MB` });
    const itemId = randomUUID();
    const sourcePath = join(this.storageDir, 'batches', batchId, 'sources', `${itemId}.bin`);
    const safeRelativePath = normalizeRelativePath(relativePath);
    let insertAttempted = false;
    try {
      await this.mysql.transaction(async (db) => {
        const batch = await this.getBatchRow(batchId, apiKeyId, db, true);
        if (batch.status !== 'draft') throw new ConflictException({ code: ErrorCode.INVALID_STATE, message: 'batch is no longer accepting files' });
        this.validateFile(file, batch.kind, batch.op);
        const counts = await db.query<Array<{ count: number | string; total_size: number | string; max_sequence: number | string }>>(
          `SELECT COUNT(*) AS count, COALESCE(SUM(source_size), 0) AS total_size, COALESCE(MAX(sequence_no), 0) AS max_sequence FROM batch_items WHERE batch_id = ?`, [batchId]);
        if (Number(counts[0]?.count ?? 0) >= this.maxFiles) throw new BadRequestException({ code: ErrorCode.FILE_COUNT_MISMATCH, message: `batch exceeds the maximum of ${this.maxFiles} files` });
        if (Number(counts[0]?.total_size ?? 0) + file.buffer.length > this.maxTotalBytes) throw new BadRequestException({ code: ErrorCode.FILE_TOO_LARGE, message: 'batch exceeds the total size limit' });
        const sequenceNo = Number(counts[0]?.max_sequence ?? 0) + 1;
        await mkdir(dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, file.buffer);
        insertAttempted = true;
        await db.execute(
          `INSERT INTO batch_items (item_id, batch_id, sequence_no, relative_path, source_name, source_path, source_size, source_sha256, source_password_ciphertext, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded')`,
          [itemId, batchId, sequenceNo, safeRelativePath, normalizeUploadedFilename(file.originalname), sourcePath, file.buffer.length, createHash('sha256').update(file.buffer).digest('hex'), password ? this.encrypt(password) : null]);
        await this.refreshBatch(batchId, db);
      });
    } catch (err) {
      // A lost commit acknowledgement must not remove a possibly committed source.
      if (!insertAttempted) await rm(sourcePath, { force: true }).catch(() => undefined);
      throw err;
    }
    return this.getItemRequired(itemId, apiKeyId);
  }

  async commit(batchId: string, apiKeyId: string | null): Promise<BatchInfo> {
    await this.mysql.transaction(async (db) => {
      const batch = await this.getBatchRow(batchId, apiKeyId, db, true);
      const count = await db.query<Array<{ count: number | string }>>(`SELECT COUNT(*) AS count FROM batch_items WHERE batch_id = ?`, [batchId]);
      if (Number(count[0]?.count ?? 0) === 0) throw new BadRequestException({ code: ErrorCode.FILE_REQUIRED, message: 'upload at least one file before commit' });
      if (batch.status === 'draft') {
        await db.execute(`UPDATE batch_items SET status = 'queued' WHERE batch_id = ? AND status = 'uploaded'`, [batchId]);
        await db.execute(`UPDATE batches SET status = 'queued', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE batch_id = ?`, [batchId]);
      }
      await this.refreshBatch(batchId, db);
    });
    return this.getRequired(batchId, apiKeyId);
  }

  async getRequired(batchId: string, apiKeyId: string | null): Promise<BatchInfo> {
    return this.mysql.transaction(async (db) => {
      const batch = await this.getBatchRow(batchId, apiKeyId, db);
      const items = await db.query<ItemRow[]>(`SELECT * FROM batch_items WHERE batch_id = ? ORDER BY sequence_no`, [batchId]);
      const outputs = await db.query<OutputRow[]>(`SELECT o.* FROM batch_item_outputs o JOIN batch_items i ON i.item_id = o.item_id WHERE i.batch_id = ? ORDER BY i.sequence_no, o.output_sequence`, [batchId]);
      return this.toInfo(batch, items, outputs);
    });
  }

  async cancel(batchId: string, apiKeyId: string | null): Promise<BatchInfo> {
    await this.mysql.transaction(async (db) => {
      await this.getBatchRow(batchId, apiKeyId, db, true);
      await db.execute(`UPDATE batch_items SET status = 'canceled', failure_code = 'TASK_CANCELED', failure_reason = 'batch canceled by client' WHERE batch_id = ? AND status IN ('uploaded', 'queued')`, [batchId]);
      await db.execute(`UPDATE batches SET status = 'canceled', finished_at = CURRENT_TIMESTAMP WHERE batch_id = ? AND status IN ('draft', 'queued', 'processing')`, [batchId]);
      await this.refreshBatch(batchId, db);
    });
    return this.getRequired(batchId, apiKeyId);
  }

  async retry(itemId: string, password: string | undefined, apiKeyId: string | null): Promise<BatchInfo> {
    const item = await this.getItemRow(itemId, apiKeyId);
    await this.mysql.transaction(async (db) => {
      await this.getBatchRow(item.batch_id, apiKeyId, db, true);
      const current = await db.query<ItemRow[]>(`SELECT * FROM batch_items WHERE item_id = ? FOR UPDATE`, [itemId]);
      if (current[0]?.status !== 'failed') throw new ConflictException({ code: ErrorCode.INVALID_STATE, message: 'only failed items can be retried' });
      await db.execute(`DELETE FROM batch_item_outputs WHERE item_id = ?`, [itemId]);
      await db.execute(`UPDATE batch_items SET status = 'queued', failure_code = NULL, failure_reason = NULL, source_password_ciphertext = COALESCE(?, source_password_ciphertext), lease_owner = NULL, lease_until = NULL, output_path = NULL, output_name = NULL, output_content_type = NULL, output_size = NULL, finished_at = NULL WHERE item_id = ? AND status = 'failed'`, [password === undefined ? null : this.encrypt(password), itemId]);
      await db.execute(`UPDATE batches SET status = 'queued', archive_path = NULL, finished_at = NULL WHERE batch_id = ?`, [item.batch_id]);
      await this.refreshBatch(item.batch_id, db);
    });
    return this.getRequired(item.batch_id, apiKeyId);
  }

  async itemDownload(itemId: string, apiKeyId: string | null): Promise<BatchDownload | null> {
    const item = await this.getItemRow(itemId, apiKeyId);
    if (item.status !== 'success' || !item.output_path) return null;
    return { buffer: await readFile(item.output_path), contentType: item.output_content_type ?? 'application/octet-stream', filename: sanitizeFilename(item.output_name, `${itemId}-result`) };
  }

  async outputDownload(outputId: string, apiKeyId: string | null): Promise<BatchDownload | null> {
    const rows = await this.mysql.query<Array<OutputRow & { status: BatchItemStatus }>>(
      `SELECT o.*, i.status FROM batch_item_outputs o JOIN batch_items i ON i.item_id = o.item_id
       JOIN batches b ON b.batch_id = i.batch_id WHERE o.output_id = ? AND b.api_key_id = ? LIMIT 1`,
      [outputId, apiKeyId],
    );
    const output = rows[0];
    if (!output || output.status !== 'success') return null;
    return { buffer: await readFile(output.output_path), contentType: output.output_content_type, filename: sanitizeFilename(output.output_name, `${outputId}-result`) };
  }

  async cleanupExpired(): Promise<number> {
    const rows = await this.mysql.query<Array<{ batch_id: string }>>(
      `SELECT batch_id FROM batches WHERE status IN ('success', 'partial_success', 'failed', 'canceled')
       AND finished_at IS NOT NULL AND finished_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${this.retentionDays} DAY) LIMIT 100`,
    );
    let removed = 0;
    for (const row of rows) {
      removed += await this.mysql.transaction(async (db) => {
        const expired = await db.query<BatchRow[]>(`SELECT * FROM batches WHERE batch_id = ? AND status IN ('success', 'partial_success', 'failed', 'canceled') AND finished_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${this.retentionDays} DAY) FOR UPDATE`, [row.batch_id]);
        if (!expired.length) return 0;
        const active = await db.query<Array<{ count: number }>>(`SELECT COUNT(*) AS count FROM batch_items WHERE batch_id = ? AND status IN ('queued', 'processing')`, [row.batch_id]);
        if (Number(active[0]?.count)) return 0;
        await rm(join(this.storageDir, 'batches', row.batch_id), { recursive: true, force: true });
        await db.execute(`DELETE FROM batches WHERE batch_id = ?`, [row.batch_id]);
        return 1;
      });
    }
    return removed;
  }

  async batchDownload(batchId: string, apiKeyId: string | null): Promise<BatchDownload | null> {
    const snapshot = await this.mysql.transaction(async (db) => {
      const batch = await this.getBatchRow(batchId, apiKeyId, db);
      return { batch, ...await this.archiveSnapshot(batchId, db) };
    });
    if (!isDownloadable(snapshot.batch.status) || !snapshot.items.length) return null;
    const archivePath = join(this.storageDir, 'batches', batchId, 'archives', `${snapshot.version}.zip`);
    if (!existsSync(archivePath)) await this.createArchive(snapshot.items, snapshot.outputs, archivePath);
    const buffer = await readFile(archivePath);
    await this.mysql.transaction(async (db) => {
      const batch = await this.getBatchRow(batchId, apiKeyId, db, true);
      const current = await this.archiveSnapshot(batchId, db);
      if (!isDownloadable(batch.status) || current.version !== snapshot.version) {
        throw new ConflictException({ code: ErrorCode.INVALID_STATE, message: 'batch results changed; retry the download' });
      }
      await db.execute(`UPDATE batches SET archive_path = ? WHERE batch_id = ?`, [archivePath, batchId]);
    });
    return { buffer, contentType: 'application/zip', filename: `${batchId}.zip` };
  }

  async claimNext(workerId: string): Promise<ItemRow | null> {
    const candidates = await this.mysql.query<ItemRow[]>(
      `SELECT i.* FROM batch_items i JOIN batches b ON b.batch_id = i.batch_id
       WHERE (i.status = 'queued' AND b.status IN ('queued', 'processing')) OR (i.status = 'processing' AND b.status IN ('queued', 'processing', 'canceled') AND i.lease_until < CURRENT_TIMESTAMP) ORDER BY i.updated_at, i.id LIMIT 1`);
    if (!candidates[0]) return null;
    return this.mysql.transaction(async (db) => {
      // Every writer takes the parent lock first to avoid item/parent deadlocks.
      const batches = await db.query<BatchRow[]>(`SELECT * FROM batches WHERE batch_id = ? FOR UPDATE`, [candidates[0].batch_id]);
      if (!batches[0] || !['queued', 'processing', 'canceled'].includes(batches[0].status)) return null;
      const rows = await db.query<ItemRow[]>(`SELECT * FROM batch_items WHERE item_id = ? AND (status = 'queued' OR (status = 'processing' AND lease_until < CURRENT_TIMESTAMP)) FOR UPDATE`, [candidates[0].item_id]);
      const item = rows[0];
      if (!item) return null;
      if (batches[0].status === 'canceled' && item.status !== 'processing') return null;
      if (item.lease_owner) await db.execute(`UPDATE batch_attempts SET status = 'failed', failure_code = 'LEASE_EXPIRED', finished_at = CURRENT_TIMESTAMP WHERE attempt_id = ? AND status = 'processing'`, [item.lease_owner]);
      const leaseOwner = randomUUID();
      const attemptCount = Number(item.attempt_count) + 1;
      await db.execute(`UPDATE batch_items SET status = 'processing', lease_owner = ?, lease_until = ?, attempt_count = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE item_id = ?`, [leaseOwner, new Date(Date.now() + LEASE_MS), attemptCount, item.item_id]);
      await db.execute(`INSERT INTO batch_attempts (attempt_id, item_id, attempt_no, worker_id, status) VALUES (?, ?, ?, ?, 'processing')`, [leaseOwner, item.item_id, attemptCount, workerId]);
      await this.refreshBatch(item.batch_id, db);
      return { ...item, status: 'processing', lease_owner: leaseOwner, attempt_count: attemptCount };
    });
  }

  async process(item: ItemRow): Promise<void> {
    const startedAt = Date.now();
    if (!item.lease_owner) throw new Error('batch item processing requires a lease');
    const leaseOwner = item.lease_owner;
    const outputDir = join(this.storageDir, 'batches', item.batch_id, 'outputs', item.item_id, leaseOwner);
    let published = false;
    let publicationUncertain = false;
    try {
      const batch = await this.mysql.query<BatchRow[]>(`SELECT * FROM batches WHERE batch_id = ? LIMIT 1`, [item.batch_id]);
      if (!batch[0]) return;
      const request = parseJson(batch[0].request_json);
      if (batch[0].output_passwords_ciphertext) Object.assign(request, parseJson(this.decrypt(batch[0].output_passwords_ciphertext)));
      const options = parseJson(batch[0].options_json);
      const password = item.source_password_ciphertext ? this.decrypt(item.source_password_ciphertext) : undefined;
      if (password) request.password = password;
      const file: MulterFile = { buffer: await readFile(item.source_path), originalname: item.source_name, mimetype: mimeFor(item.source_name) };
      const result = await this.dispatch(batch[0], file, request, options, password);
      const buffer = result.buffer;
      const outputPath = join(outputDir, 'result.bin');
      await mkdir(outputDir, { recursive: true });
      await writeFile(outputPath, buffer);
      const requestedName = PDF_DECORATION_OPS.has(batch[0].op) && typeof request.outputFileName === 'string' && request.outputFileName.trim()
        ? request.outputFileName.trim() : undefined;
      const outputName = requestedName ? sanitizeFilename(requestedName, 'result.pdf') : outputFilename(result, item.source_name, batch[0].op, batch[0].target, batch[0].type);
      const outputs = await this.materializeOutputs(item, batch[0].op, outputPath, outputName, contentTypeOf(result), buffer);
      publicationUncertain = true;
      published = await this.mysql.transaction(async (db) => {
        await db.query(`SELECT batch_id FROM batches WHERE batch_id = ? FOR UPDATE`, [item.batch_id]);
        const updated = await db.execute(`UPDATE batch_items SET status = 'success', output_path = ?, output_name = ?, output_content_type = ?, output_size = ?, failure_code = NULL, failure_reason = NULL, lease_owner = NULL, lease_until = NULL, finished_at = CURRENT_TIMESTAMP WHERE item_id = ? AND status = 'processing' AND lease_owner = ?`, [outputPath, outputName, contentTypeOf(result), buffer.length, item.item_id, leaseOwner]);
        if (!updated.affectedRows) return false;
        await db.execute(`DELETE FROM batch_item_outputs WHERE item_id = ?`, [item.item_id]);
        for (const output of outputs) {
          await db.execute(`INSERT INTO batch_item_outputs (output_id, item_id, output_sequence, output_name, output_path, output_content_type, output_size) VALUES (?, ?, ?, ?, ?, ?, ?)`, [output.output_id, output.item_id, output.output_sequence, output.output_name, output.output_path, output.output_content_type, output.output_size]);
        }
        await db.execute(`UPDATE batch_attempts SET status = 'success', finished_at = CURRENT_TIMESTAMP WHERE attempt_id = ? AND status = 'processing'`, [leaseOwner]);
        await db.execute(`UPDATE batches SET archive_path = NULL WHERE batch_id = ?`, [item.batch_id]);
        await this.refreshBatch(item.batch_id, db);
        return true;
      });
      publicationUncertain = false;
    } catch (err) {
      const e = err as Error;
      const failureCode = err instanceof UpstreamSdkError ? (err.errorCode ?? (err.code > 0 ? String(err.code) : ErrorCode.UPSTREAM_ERROR)) : 'TASK_ERROR';
      this.logger.warn(`batch item ${item.item_id} failed after ${Date.now() - startedAt}ms: ${e.message}`);
      await this.mysql.transaction(async (db) => {
        await db.query(`SELECT batch_id FROM batches WHERE batch_id = ? FOR UPDATE`, [item.batch_id]);
        const result = await db.execute(`UPDATE batch_items SET status = 'failed', failure_code = ?, failure_reason = ?, lease_owner = NULL, lease_until = NULL, finished_at = CURRENT_TIMESTAMP WHERE item_id = ? AND status = 'processing' AND lease_owner = ?`, [failureCode, e.message.slice(0, 1000), item.item_id, leaseOwner]);
        if (!result.affectedRows) return;
        await db.execute(`UPDATE batch_attempts SET status = 'failed', failure_code = ?, failure_reason = ?, finished_at = CURRENT_TIMESTAMP WHERE attempt_id = ? AND status = 'processing'`, [failureCode, e.message.slice(0, 1000), leaseOwner]);
        await this.refreshBatch(item.batch_id, db);
      });
    } finally {
      // Keep staged files if commit's outcome is unknown; retention will remove them.
      if (!published && !publicationUncertain) await rm(outputDir, { recursive: true, force: true }).catch((err) => this.logger.warn(`batch output cleanup failed: ${(err as Error).message}`));
    }
  }

  private async dispatch(batch: BatchRow, file: MulterFile, request: Record<string, unknown>, options: Record<string, unknown>, password?: string): Promise<SdkFileResult | ConversionResult> {
    const token = '';
    if (batch.kind === 'pdf') {
      switch (batch.op) {
        case 'split': return this.pdfSdk.split(file, request, token);
        case 'extract': return this.pdfSdk.extract(file, request, token);
        case 'insert-blank': return this.pdfSdk.insertBlank(file, request, token);
        case 'delete': return this.pdfSdk.delete(file, request, token);
        case 'rotate': return this.pdfSdk.rotate(file, request, token);
        case 'encrypt': return this.pdfSdk.encrypt(file, request, token);
        case 'decrypt': return this.pdfSdk.decrypt(file, request, token);
        case 'watermark/add': return this.pdfSdk.addWatermark(file, request, token);
        case 'watermark/remove': return this.pdfSdk.removeWatermark(file, request, token);
        case 'headers-footers/add': return this.pdfSdk.addHeadersFooters(file, request, token);
        case 'headers-footers/remove': return this.pdfSdk.removeHeadersFooters(file, request, token);
        case 'bates/add': return this.pdfSdk.addBates(file, request, token);
        case 'bates/remove': return this.pdfSdk.removeBates(file, request, token);
        case 'compress': return this.pdfSdk.compress(file, request, token);
        case 'generation/html-to-pdf': return this.pdfSdk.htmlToPdf(file, request, token);
        default: throw new Error(`unsupported batch pdf op: ${batch.op}`);
      }
    }
    if (batch.op === 'convert') {
      if (batch.type) return this.conv.convertByType(file, batch.type, token, options, password);
      if (batch.target) return this.conv.convert(file, batch.target as any, token, options, password);
      throw new Error('batch convert requires target or type');
    }
    if (batch.op === 'convert-to-pdf') return this.conv.convertToPdf(file, token, batch.type ?? undefined, options, password);
    if (batch.op === 'documentai') return this.conv.documentAi(batch.operation as any, file, token, options);
    throw new Error(`unsupported batch conversion op: ${batch.op}`);
  }

  private validateFile(file: Express.Multer.File, kind: BatchKind, op: string): void {
    const name = normalizeUploadedFilename(file.originalname || 'file');
    if (!file.originalname?.trim() || !name) throw new BadRequestException({ code: ErrorCode.INVALID_FILE_TYPE, message: 'uploaded file name is invalid' });
    const requiresPdf = kind === 'pdf' && op !== 'generation/html-to-pdf';
    if (requiresPdf && !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new BadRequestException({ code: ErrorCode.INVALID_FILE_TYPE, message: `batch operation ${op} requires a PDF file` });
    }
  }

  private async materializeOutputs(
    item: ItemRow,
    op: string,
    outputPath: string,
    outputName: string,
    contentType: string,
    buffer: Buffer,
  ): Promise<Array<{ output_id: string; item_id: string; output_sequence: number; output_name: string; output_path: string; output_content_type: string; output_size: number }>> {
    const original = { output_id: randomUUID(), item_id: item.item_id, output_sequence: 1, output_name: outputName, output_path: outputPath, output_content_type: contentType, output_size: buffer.length };
    if (op !== 'split' || !isZipBuffer(buffer)) return [original];
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(buffer);
    } catch {
      return [original];
    }
    const outputDir = dirname(outputPath);
    await mkdir(outputDir, { recursive: true });
    const materialized: typeof original[] = [];
    let sequence = 0;
    let totalBytes = 0;
    for (const [entryName, bytes] of Object.entries(entries)) {
      if (!entryName || entryName.endsWith('/')) continue;
      if (sequence >= 1000) throw new Error('split result contains too many output files');
      if (bytes.length > this.maxFileBytes) throw new Error('split output exceeds the per-file limit');
      totalBytes += bytes.length;
      if (totalBytes > this.maxTotalBytes) throw new Error('split result exceeds the total size limit');
      sequence += 1;
      const safeName = sanitizeFilename(entryName.split(/[\\/]/).pop(), `${item.item_id}-${sequence}.bin`);
      const path = join(outputDir, `${sequence}-${randomUUID()}.bin`);
      await writeFile(path, Buffer.from(bytes));
      materialized.push({ output_id: randomUUID(), item_id: item.item_id, output_sequence: sequence, output_name: safeName, output_path: path, output_content_type: mimeFor(safeName), output_size: bytes.length });
    }
    return materialized.length ? materialized : [original];
  }

  private validateOperation(kind: BatchKind, op: string): void {
    if (op === 'merge') throw new BadRequestException({ code: ErrorCode.UNSUPPORTED_OPERATION, message: 'merge is not supported by batch processing' });
    if ((kind === 'pdf' && !SUPPORTED_PDF_OPS.has(op)) || (kind === 'conversion' && !SUPPORTED_CONVERSION_OPS.has(op))) {
      throw new BadRequestException({ code: ErrorCode.UNSUPPORTED_OPERATION, message: `unsupported batch operation: ${kind}/${op}` });
    }
  }

  private async getBatchRow(batchId: string, apiKeyId: string | null, db: MysqlTransaction = this.mysql, lock = false): Promise<BatchRow> {
    const rows = await db.query<BatchRow[]>(`SELECT * FROM batches WHERE batch_id = ? AND api_key_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [batchId, apiKeyId]);
    if (!rows[0]) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'batch not found' });
    return rows[0];
  }

  private async getItemRow(itemId: string, apiKeyId: string | null, db: MysqlTransaction = this.mysql): Promise<ItemRow> {
    const rows = await db.query<ItemRow[]>(`SELECT i.* FROM batch_items i JOIN batches b ON b.batch_id = i.batch_id WHERE i.item_id = ? AND b.api_key_id = ? LIMIT 1`, [itemId, apiKeyId]);
    if (!rows[0]) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'batch item not found' });
    return rows[0];
  }

  private async getItemRequired(itemId: string, apiKeyId: string | null): Promise<BatchItemInfo> {
    return this.mysql.transaction(async (db) => {
      const item = await this.getItemRow(itemId, apiKeyId, db);
      const outputs = await db.query<OutputRow[]>(`SELECT * FROM batch_item_outputs WHERE item_id = ? ORDER BY output_sequence`, [itemId]);
      return {
        itemId: item.item_id,
        sequenceNo: Number(item.sequence_no),
        sourceName: item.source_name,
        sourceSize: Number(item.source_size),
        status: item.status,
        attemptCount: Number(item.attempt_count),
        outputName: item.output_name ?? undefined,
        outputSize: item.output_size == null ? undefined : Number(item.output_size),
        failureCode: item.failure_code ?? undefined,
        failureReason: item.failure_reason ?? undefined,
        downloadUrl: item.status === 'success' ? `/api/v1/batches/items/${item.item_id}/download` : undefined,
        relativePath: item.relative_path ?? undefined,
        outputs: outputs.length ? outputs.map(toOutputInfo) : undefined,
      };
    });
  }

  private async refreshBatch(batchId: string, db: MysqlTransaction): Promise<void> {
    await db.execute(
      `UPDATE batches b SET
         total_count = (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.batch_id),
         queued_count = (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.batch_id AND i.status = 'queued'),
         processing_count = (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.batch_id AND i.status = 'processing'),
         success_count = (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.batch_id AND i.status = 'success'),
         failed_count = (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.batch_id AND i.status = 'failed'),
         canceled_count = (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.batch_id AND i.status = 'canceled')
       WHERE b.batch_id = ?`, [batchId]);
    const rows = await db.query<Array<{ status: BatchStatus; total_count: number; uploaded_count: number; queued_count: number; processing_count: number; success_count: number; failed_count: number; canceled_count: number }>>(`SELECT b.status,b.total_count,
         (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.batch_id AND i.status = 'uploaded') AS uploaded_count,
         b.queued_count,b.processing_count,b.success_count,b.failed_count,b.canceled_count
       FROM batches b WHERE b.batch_id = ?`, [batchId]);
    const r = rows[0];
    if (!r || r.status === 'canceled' || r.total_count === 0 || (r.status === 'draft' && r.uploaded_count > 0)) return;
    const terminal = r.queued_count === 0 && r.processing_count === 0 && r.success_count + r.failed_count + r.canceled_count === r.total_count;
    const status: BatchStatus = terminal ? (r.success_count === r.total_count ? 'success' : r.success_count > 0 ? 'partial_success' : 'failed') : (r.processing_count > 0 ? 'processing' : 'queued');
    await db.execute(`UPDATE batches SET status = ?, finished_at = CASE WHEN ? IN ('success','partial_success','failed') THEN COALESCE(finished_at, CURRENT_TIMESTAMP) ELSE NULL END WHERE batch_id = ? AND status <> 'canceled'`, [status, status, batchId]);
  }

  private toInfo(batch: BatchRow, items: ItemRow[], outputs: OutputRow[] = []): BatchInfo {
    const outputsByItem = new Map<string, BatchOutputInfo[]>();
    for (const output of outputs) {
      const list = outputsByItem.get(output.item_id) ?? [];
      list.push(toOutputInfo(output));
      outputsByItem.set(output.item_id, list);
    }
    return {
      batchId: batch.batch_id, kind: batch.kind, op: batch.op, target: batch.target ?? undefined, type: batch.type ?? undefined, operation: batch.operation ?? undefined,
      status: batch.status, totalCount: Number(batch.total_count), queuedCount: Number(batch.queued_count), processingCount: Number(batch.processing_count), successCount: Number(batch.success_count), failedCount: Number(batch.failed_count), canceledCount: Number(batch.canceled_count),
      createdAt: dateString(batch.created_at), startedAt: dateString(batch.started_at), finishedAt: dateString(batch.finished_at), downloadUrl: `/api/v1/batches/${batch.batch_id}/download`,
      items: items.map((item) => ({ itemId: item.item_id, sequenceNo: Number(item.sequence_no), sourceName: item.source_name, sourceSize: Number(item.source_size), status: item.status, attemptCount: Number(item.attempt_count), outputName: item.output_name ?? undefined, outputSize: item.output_size == null ? undefined : Number(item.output_size), failureCode: item.failure_code ?? undefined, failureReason: item.failure_reason ?? undefined, downloadUrl: item.status === 'success' ? `/api/v1/batches/items/${item.item_id}/download` : undefined, relativePath: item.relative_path ?? undefined, outputs: outputsByItem.get(item.item_id) })),
    };
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
  }

  private decrypt(value: string): string {
    const [iv, tag, encrypted] = value.split('.');
    const decipher = createDecipheriv('aes-256-gcm', this.secret, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  }

  private async archiveSnapshot(batchId: string, db: MysqlTransaction) {
    const items = await db.query<ItemRow[]>(`SELECT * FROM batch_items WHERE batch_id = ? AND status = 'success' ORDER BY sequence_no`, [batchId]);
    const stored = await db.query<OutputRow[]>(`SELECT o.* FROM batch_item_outputs o JOIN batch_items i ON i.item_id = o.item_id WHERE i.batch_id = ? AND i.status = 'success' ORDER BY i.sequence_no, o.output_sequence`, [batchId]);
    // Pre-upgrade successes have only the legacy item output, not manifest rows.
    const outputs = items.flatMap((item) => {
      const own = stored.filter((output) => output.item_id === item.item_id);
      return own.length ? own : item.output_path ? [{ output_id: item.item_id, item_id: item.item_id, output_sequence: 1, output_name: item.output_name ?? `${item.item_id}.bin`, output_path: item.output_path, output_content_type: item.output_content_type ?? 'application/octet-stream', output_size: Number(item.output_size ?? 0) }] : [];
    });
    const version = createHash('sha256').update(JSON.stringify({ items: items.map((item) => [item.item_id, item.sequence_no, item.relative_path]), outputs })).digest('hex');
    return { items, outputs, version };
  }

  private async createArchive(items: ItemRow[], outputs: OutputRow[], archivePath: string): Promise<void> {
    await mkdir(dirname(archivePath), { recursive: true });
    const temporaryPath = `${archivePath}.${randomUUID()}.tmp`;
    try {
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(temporaryPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        const fail = (err: Error) => { archive.abort(); output.destroy(); reject(err); };
        output.on('close', resolve);
        output.on('error', fail);
        archive.on('error', fail);
        archive.on('warning', fail);
        archive.pipe(output);
        const itemInfo = new Map(items.map((item) => [item.item_id, { sequence: item.sequence_no, relativePath: item.relative_path }]));
        for (const output of outputs) {
          const item = itemInfo.get(output.item_id);
          const itemSequence = item?.sequence ?? 0;
          const outputName = sanitizeFilename(output.output_name, `${output.output_id}.bin`);
          const normalizedRelative = item?.relativePath?.replace(/\\/g, '/');
          const separator = normalizedRelative?.lastIndexOf('/') ?? -1;
          const folder = separator > 0 ? `${normalizedRelative!.slice(0, separator + 1)}` : '';
          archive.file(output.output_path, { name: `${folder}${String(itemSequence).padStart(4, '0')}-${String(output.output_sequence).padStart(3, '0')}-${outputName}` });
        }
        void archive.finalize().catch(fail);
      });
      try {
        await rename(temporaryPath, archivePath);
      } catch (err) {
        if (!existsSync(archivePath)) throw err;
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function parseJson(value: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return { ...value };
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

function outputFilename(result: SdkFileResult | ConversionResult, sourceName: string, op: string, target?: string | null, type?: string | null): string {
  const header = (result as SdkFileResult).headers?.['content-disposition'];
  const upstream = header ? parseFilenameFromHeader(header) : (result as ConversionResult).filename;
  if (upstream) return sanitizeFilename(upstream, `${sourceName}-result`);
  if (op === 'convert-to-pdf') return `${sourceName.replace(/\.[^.]*$/, '')}.pdf`;
  const ext = target ?? type?.split('/').pop();
  return sanitizeFilename(ext ? `${sourceName.replace(/\.[^.]*$/, '')}.${ext === 'markdown' ? 'md' : ext}` : sourceName, `${op}-result`);
}

function contentTypeOf(result: SdkFileResult | ConversionResult): string {
  return (result as SdkFileResult).headers?.['content-type'] ?? (result as ConversionResult).contentType ?? 'application/octet-stream';
}

function dateString(value: Date | string | null | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  return ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', html: 'text/html', txt: 'text/plain' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}

function hasPasswordField(value: Record<string, unknown> | undefined, allowed: string[] = []): boolean {
  return !!value && Object.keys(value).some((key) => /password/i.test(key) && !allowed.includes(key));
}

function isDownloadable(status: BatchStatus): boolean {
  return ['success', 'partial_success', 'failed'].includes(status);
}

function toOutputInfo(output: OutputRow): BatchOutputInfo {
  return {
    outputId: output.output_id,
    sequenceNo: Number(output.output_sequence),
    name: output.output_name,
    size: Number(output.output_size),
    contentType: output.output_content_type,
    downloadUrl: `/api/v1/batches/items/${output.item_id}/outputs/${output.output_id}/download`,
  };
}

function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
}

function normalizeRelativePath(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new BadRequestException({ code: ErrorCode.INVALID_ARGUMENT, message: 'relativePath must not be absolute' });
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new BadRequestException({ code: ErrorCode.INVALID_ARGUMENT, message: 'relativePath contains an invalid path segment' });
  }
  const cleaned = parts.map((part) => sanitizeFilename(part, '')).filter(Boolean).join('/');
  if (!cleaned) throw new BadRequestException({ code: ErrorCode.INVALID_ARGUMENT, message: 'relativePath is invalid' });
  return cleaned.slice(0, 1024);
}
