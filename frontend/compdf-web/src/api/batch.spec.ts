// @vitest-environment happy-dom

import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Endpoint } from '../config/convert-map';
import { batchApi, buildBatchRequest, type BatchInfo, type BatchItemInfo } from './batch';
import { http, toApiError } from './client';

const item: BatchItemInfo = {
  itemId: 'item-1', sequenceNo: 1, sourceName: 'locked.pdf', sourceSize: 123,
  status: 'uploaded', attemptCount: 0,
};
const batch: BatchInfo = {
  batchId: 'batch-1', kind: 'pdf', op: 'split', status: 'draft',
  totalCount: 1, queuedCount: 0, processingCount: 0, successCount: 0,
  failedCount: 0, canceledCount: 0, items: [item],
};

describe('batch API over the shared client', () => {
  const originalAdapter = http.defaults.adapter;
  const originalConfig = window.COMPDF_CONFIG;
  const adapter = vi.fn<(config: InternalAxiosRequestConfig) => Promise<AxiosResponse>>();

  function respond(data: unknown, status = 200, headers: Record<string, string> = {}) {
    adapter.mockImplementationOnce(async (config) => ({
      data, status, statusText: 'OK', headers, config,
    }));
  }

  function success(data: unknown, status = 200) {
    respond({ code: 200, msg: 'success', data }, status);
  }

  function lastRequest() {
    return adapter.mock.calls[adapter.mock.calls.length - 1]![0];
  }

  beforeEach(() => {
    adapter.mockReset();
    http.defaults.adapter = adapter;
    window.COMPDF_CONFIG = {
      siteName: 'Test', logoUrl: null, themeColor: '#1668ff', darkMode: false,
      upgradeBannerText: null, docUrl: null, contactUrl: null, compdfToolsEnabled: true,
      licenseType: 'UNKNOWN', licenseTypeValue: 0, isFormalLicense: false,
      ...originalConfig, apiKey: 'batch-test-key',
    };
  });

  afterEach(() => {
    http.defaults.adapter = originalAdapter;
    window.COMPDF_CONFIG = originalConfig;
  });

  it('creates a batch from an HTTP 201 envelope with API-key authentication', async () => {
    success(batch, 201);
    const request = {
      kind: 'pdf' as const, op: 'encrypt' as const, idempotencyKey: 'unique-key',
      request: { userPassword: 'output-user', ownerPassword: 'output-owner' },
    };
    expect(await batchApi.create(request)).toEqual(batch);
    const config = lastRequest();
    expect(config.url).toBe('/batches');
    expect(config.method).toBe('post');
    expect(JSON.parse(config.data)).toEqual(request);
    expect(config.headers.get('x-api-key')).toBe('batch-test-key');
    expect(config.headers.get('Authorization')).toBeUndefined();
  });

  it.each([undefined, '', 'per-file-secret'])('uploads one file with password %s', async (password) => {
    success(item);
    const file = new File(['source'], 'locked.pdf', { type: 'application/pdf' });
    expect(await batchApi.upload('batch/1', file, password)).toEqual(item);
    const config = lastRequest();
    expect(config.url).toBe('/batches/batch%2F1/files');
    expect(config.method).toBe('post');
    expect(config.data).toBeInstanceOf(FormData);
    const form = config.data as FormData;
    expect(Array.from(form.keys())).toEqual(password === undefined ? ['file'] : ['file', 'password']);
    expect((form.get('file') as File).name).toBe('locked.pdf');
    expect(await (form.get('file') as File).text()).toBe('source');
    expect(form.get('password')).toBe(password ?? null);
  });

  it('sends the folder-relative path alongside the individual file password', async () => {
    const relativePath = 'Case A/subfolder/locked.pdf';
    success({ ...item, relativePath });
    const file = new File(['source'], 'locked.pdf', { type: 'application/pdf' });
    expect(await batchApi.upload('batch-1', file, 'file-password', relativePath))
      .toMatchObject({ relativePath });
    const form = lastRequest().data as FormData;
    expect(form.get('relativePath')).toBe(relativePath);
    expect(form.get('password')).toBe('file-password');
    expect(form.getAll('file')).toHaveLength(1);
  });

  it.each([
    ['submit', 'post', '/batches/batch%2F1/commit'],
    ['status', 'get', '/batches/batch%2F1'],
    ['cancel', 'post', '/batches/batch%2F1/cancel'],
  ] as const)('%s returns the batch snapshot', async (method, verb, url) => {
    success({ ...batch, status: 'processing' });
    expect(await batchApi[method]('batch/1')).toEqual({ ...batch, status: 'processing' });
    expect(lastRequest().method).toBe(verb);
    expect(lastRequest().url).toBe(url);
    expect(lastRequest().data).toBeUndefined();
  });

  it.each([undefined, {}, { password: 'correct-password' }, { password: '' }])(
    'retries without re-uploading and returns the entire batch (%j)', async (request) => {
      success({ ...batch, status: 'queued' });
      expect(await batchApi.retry('item/1', request)).toEqual({ ...batch, status: 'queued' });
      expect(lastRequest().url).toBe('/batches/items/item%2F1/retry');
      expect(lastRequest().method).toBe('post');
      expect(JSON.parse(lastRequest().data)).toEqual(request ?? {});
    },
  );

  it('filters before pagination, uses sequence order, and leaves the snapshot untouched', async () => {
    const items: BatchItemInfo[] = [
      { ...item, itemId: 'third', sequenceNo: 3, status: 'failed' },
      { ...item, itemId: 'second', sequenceNo: 2, status: 'success' },
      { ...item, itemId: 'first', sequenceNo: 1, status: 'failed' },
    ];
    success({ ...batch, items, totalCount: 3 });
    expect(await batchApi.files('batch-1', { page: 2, pageSize: 1, status: 'failed' })).toEqual({
      items: [items[0]], total: 2, page: 2, pageSize: 1,
    });
    expect(lastRequest().url).toBe('/batches/batch-1');
    expect(lastRequest().params).toBeUndefined();
    expect(items.map((entry) => entry.sequenceNo)).toEqual([3, 2, 1]);
  });

  it('defaults pagination and returns an empty out-of-range page with the correct total', async () => {
    success(batch);
    expect(await batchApi.files('batch-1')).toEqual({ items: [item], total: 1, page: 1, pageSize: 20 });
    success(batch);
    expect(await batchApi.files('batch-1', { page: 2 })).toEqual({ items: [], total: 1, page: 2, pageSize: 20 });
  });

  it.each([{ page: 0 }, { page: -1 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: Infinity }, { page: NaN }])(
    'rejects invalid pagination before making a request (%j)', async (query) => {
      await expect(batchApi.files('batch-1', query)).rejects.toThrow(RangeError);
      expect(adapter).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['downloadItem', '/batches/items/id%2F1/download', 'result.pdf', 'application/pdf'],
    ['archive', '/batches/id%2F1/download', 'batch.zip', 'application/zip'],
  ] as const)('%s preserves binary data and the filename header', async (method, url, filename, type) => {
    const blob = new Blob(['binary'], { type });
    const disposition = `attachment; filename="${filename}"`;
    respond(blob, 200, { 'content-disposition': disposition, 'content-type': type });
    const result = await batchApi[method]('id/1');
    expect(result.data).toBe(blob);
    expect(result.headers['content-disposition']).toBe(disposition);
    expect(lastRequest().url).toBe(url);
    expect(lastRequest().method).toBe('get');
    expect(lastRequest().responseType).toBe('blob');
    expect(lastRequest().headers.get('x-api-key')).toBe('batch-test-key');
  });

  it('propagates a server validation error for normalization by toApiError', async () => {
    const errorBody = {
      type: 'server', code: 100001, errorCode: 'INVALID_STATE',
      message: 'only failed items can be retried', traceId: 'test-trace',
    };
    adapter.mockImplementationOnce(async (config) => {
      throw new AxiosError('Request failed', AxiosError.ERR_BAD_REQUEST, config, undefined, {
        data: errorBody, status: 409, statusText: 'Conflict', headers: {}, config,
      });
    });
    const error = await batchApi.retry('item-1').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AxiosError);
    expect(await toApiError(error)).toEqual(errorBody);
  });

  it('rejects a JSON business error returned as a download blob', async () => {
    const errorBody = {
      type: 'server', code: 100001, errorCode: 'TASK_NOT_READY',
      message: 'batch item is not ready', traceId: 'test-trace',
    };
    respond(new Blob([JSON.stringify(errorBody)], { type: 'application/json' }));
    const error = await batchApi.downloadItem('item-1').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AxiosError);
    expect(await toApiError(error)).toEqual(errorBody);
  });
});

describe('buildBatchRequest', () => {
  it.each(['headers-footers/add', 'headers-footers/remove', 'bates/remove'] as const)(
    'targets the documented %s operation', (op) => {
      expect(buildBatchRequest({ kind: 'pdf', op }, { outputFileName: 'result.pdf' })).toEqual({
        kind: 'pdf', op, request: { outputFileName: 'result.pdf' },
      });
    },
  );

  it('explicitly requests the documented per-file Bates numbering mode', () => {
    const parameters = { position: 'bottomRight', startNumber: 1, digits: 6, prefix: 'CASE-' };
    expect(buildBatchRequest({ kind: 'pdf', op: 'bates/add' }, parameters)).toEqual({
      kind: 'pdf', op: 'bates/add', request: parameters, options: { numberingMode: 'per-file' },
    });
  });

  it('preserves output encryption passwords and does not mutate parameters', () => {
    const parameters = Object.freeze({ userPassword: 'output', ownerPassword: 'owner', permissions: 4 });
    expect(buildBatchRequest({ kind: 'pdf', op: 'encrypt' }, parameters, 'idempotency-key')).toEqual({
      kind: 'pdf', op: 'encrypt', request: parameters, idempotencyKey: 'idempotency-key',
    });
  });

  it.each(['merge', 'insert-from-pdf', 'pdfa'] as const)('returns null for unsupported %s', (op) => {
    expect(buildBatchRequest({ kind: 'pdf', op })).toBeNull();
  });

  const conversions: Array<[Endpoint, Record<string, unknown>]> = [
    [{ kind: 'convert-target', target: 'docx' }, { op: 'convert', target: 'docx' }],
    [{ kind: 'convert-target', target: 'png' }, { op: 'convert', target: 'png' }],
    [{ kind: 'convert-type', type: 'img/docx' }, { op: 'convert', type: 'img/docx' }],
    [{ kind: 'convert-type', type: 'img/json' }, { op: 'convert', type: 'img/json' }],
    [{ kind: 'convert-type', type: 'pdf/pdf' }, { op: 'convert', type: 'pdf/pdf' }],
    [{ kind: 'convert-type', type: 'pdf/markdown' }, { op: 'convert', type: 'pdf/markdown' }],
    [{ kind: 'convert-to-pdf', type: 'png/pdf' }, { op: 'convert-to-pdf', type: 'png/pdf' }],
    [{ kind: 'convert-to-pdf', type: 'docx/pdf' }, { op: 'convert-to-pdf', type: 'docx/pdf' }],
    [{ kind: 'convert-to-pdf' }, { op: 'convert-to-pdf' }],
  ];

  it.each(conversions)('maps %j without losing conversion type', (endpoint, expected) => {
    const parameters = { isAllowOcr: true, outputFileName: '{filename}.pdf' };
    expect(buildBatchRequest(endpoint, parameters)).toEqual({
      kind: 'conversion', ...expected, options: parameters,
    });
  });
});
