import type { AxiosResponse } from 'axios';
import type { Endpoint } from '../config/convert-map';
import { http } from './client';

export type BatchKind = 'pdf' | 'conversion';
export type BatchStatus = 'draft' | 'queued' | 'processing' | 'success' | 'partial_success' | 'failed' | 'canceled';
export type BatchItemStatus = 'uploaded' | 'queued' | 'processing' | 'success' | 'failed' | 'canceled';
export type BatchPdfOp = 'split' | 'extract' | 'insert-blank' | 'delete' | 'rotate'
  | 'encrypt' | 'decrypt' | 'watermark/add' | 'watermark/remove' | 'compress' | 'generation/html-to-pdf'
  | 'headers-footers/add' | 'headers-footers/remove' | 'bates/add' | 'bates/remove';

/** Source passwords belong to upload/retry; output encryption passwords belong to request. */
export interface BatchParameters extends Record<string, unknown> {
  password?: never;
}

export interface CreateBatchRequest {
  kind: BatchKind;
  op: BatchPdfOp | 'convert' | 'convert-to-pdf' | 'documentai';
  target?: string;
  type?: string;
  operation?: string;
  request?: BatchParameters;
  options?: BatchParameters;
  idempotencyKey?: string;
}

export interface BatchItemInfo {
  itemId: string;
  sequenceNo: number;
  sourceName: string;
  sourceSize: number;
  relativePath?: string;
  status: BatchItemStatus;
  attemptCount: number;
  outputName?: string;
  outputSize?: number;
  failureCode?: string;
  failureReason?: string;
  downloadUrl?: string;
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

export interface BatchFilesQuery {
  /** One-based page; defaults to 1. */
  page?: number;
  /** Positive integer; defaults to 20. */
  pageSize?: number;
  status?: BatchItemStatus;
}

export interface BatchFilesPage {
  items: BatchItemInfo[];
  /** Number of items after the optional status filter. */
  total: number;
  page: number;
  pageSize: number;
}

export interface RetryBatchItemRequest {
  /** Omit to reuse the stored source password. */
  password?: string;
}

/**
 * Returns null for catalog operations unavailable in batch mode.
 * Keep full conversion types (especially img/* and png/pdf) unchanged.
 * Parameters go to PDF request or conversion options. Bates addition explicitly
 * opts into per-file numbering; it does not promise continuous batch numbering.
 * Matches the backend's PDF decoration operations and per-item password contract.
 */
export function buildBatchRequest(
  endpoint: Endpoint,
  parameters: BatchParameters = {},
  idempotencyKey?: string,
): CreateBatchRequest | null {
  const common = idempotencyKey === undefined ? {} : { idempotencyKey };
  switch (endpoint.kind) {
    case 'pdf':
      if (endpoint.op === 'merge' || endpoint.op === 'insert-from-pdf' || endpoint.op === 'pdfa') return null;
      return {
        ...common, kind: 'pdf', op: endpoint.op, request: { ...parameters },
        ...(endpoint.op === 'bates/add' ? { options: { numberingMode: 'per-file' } } : {}),
      };
    case 'convert-target':
      return { ...common, kind: 'conversion', op: 'convert', target: endpoint.target, options: { ...parameters } };
    case 'convert-type':
      return { ...common, kind: 'conversion', op: 'convert', type: endpoint.type, options: { ...parameters } };
    case 'convert-to-pdf':
      return {
        ...common, kind: 'conversion', op: 'convert-to-pdf',
        ...(endpoint.type === undefined ? {} : { type: endpoint.type }),
        options: { ...parameters },
      };
  }
}

const batchPath = (batchId: string) => `/batches/${encodeURIComponent(batchId)}`;
const itemPath = (itemId: string) => `/batches/items/${encodeURIComponent(itemId)}`;

/** JSON methods return unwrapped payloads; downloads retain headers for downloadBlob(). */
export const batchApi = {
  create: (request: CreateBatchRequest): Promise<BatchInfo> =>
    http.post<BatchInfo>('/batches', request).then((res) => res.data),

  upload: (batchId: string, file: File, password?: string, relativePath?: string): Promise<BatchItemInfo> => {
    const form = new FormData();
    form.append('file', file);
    if (password !== undefined) form.append('password', password);
    if (relativePath) form.append('relativePath', relativePath);
    // Let the browser supply the multipart boundary.
    return http.post<BatchItemInfo>(`${batchPath(batchId)}/files`, form).then((res) => res.data);
  },

  submit: (batchId: string): Promise<BatchInfo> =>
    http.post<BatchInfo>(`${batchPath(batchId)}/commit`).then((res) => res.data),

  status: (batchId: string): Promise<BatchInfo> =>
    http.get<BatchInfo>(batchPath(batchId)).then((res) => res.data),

  /**
   * This server has no GET /batches/:id/files. Fetch its complete status snapshot
   * and paginate locally; this does not reduce server response size.
   */
  files: async (batchId: string, query: BatchFilesQuery = {}): Promise<BatchFilesPage> => {
    const { page = 1, pageSize = 20, status } = query;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError('page and pageSize must be positive safe integers');
    }
    const batch = await batchApi.status(batchId);
    const items = batch.items
      .filter((item) => status === undefined || item.status === status)
      .sort((a, b) => a.sequenceNo - b.sequenceNo);
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
  },

  downloadItem: (itemId: string): Promise<AxiosResponse<Blob>> =>
    http.get<Blob>(`${itemPath(itemId)}/download`, { responseType: 'blob' }),

  archive: (batchId: string): Promise<AxiosResponse<Blob>> =>
    http.get<Blob>(`${batchPath(batchId)}/download`, { responseType: 'blob' }),

  /** Retry returns the refreshed batch, not a single item. */
  retry: (itemId: string, request: RetryBatchItemRequest = {}): Promise<BatchInfo> =>
    http.post<BatchInfo>(`${itemPath(itemId)}/retry`, request).then((res) => res.data),

  cancel: (batchId: string): Promise<BatchInfo> =>
    http.post<BatchInfo>(`${batchPath(batchId)}/cancel`).then((res) => res.data),
};
