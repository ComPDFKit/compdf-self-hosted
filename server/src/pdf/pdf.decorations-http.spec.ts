import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import axios from 'axios';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { PdfSdkClient } from '../clients/pdf-sdk.client';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { EnvelopeInterceptor } from '../common/interceptors/envelope.interceptor';
import { UpstreamSdkError } from '../common/errors/upstream-sdk.error';
import { TaskController } from '../task/task.controller';
import { TaskService } from '../task/task.service';
import { PdfController } from './pdf.controller';

describe('decoration HTTP routes (stubbed SDK and persistence)', () => {
  let app: INestApplication;
  let baseURL: string;
  const sdk = {
    addHeadersFooters: vi.fn(), removeHeadersFooters: vi.fn(), addBates: vi.fn(), removeBates: vi.fn(),
    readHeadersFooters: vi.fn().mockResolvedValue({ headerFooter: null }),
    readBates: vi.fn().mockResolvedValue({ bates: { pages: '0,1' } }),
  };
  const create = vi.fn().mockResolvedValue({ taskId: 'task-decoration' });
  beforeAll(async () => {
    for (const method of ['addHeadersFooters', 'removeHeadersFooters', 'addBates', 'removeBates'] as const) {
      sdk[method].mockResolvedValue({ buffer: Buffer.from('%PDF result'), headers: { 'content-type': 'application/pdf' } });
    }
    const module = await Test.createTestingModule({
      controllers: [PdfController, TaskController],
      providers: [{ provide: PdfSdkClient, useValue: sdk }, { provide: TaskService, useValue: { create } }],
    }).overrideGuard(ApiKeyGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    await app.listen(0, '127.0.0.1');
    baseURL = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });

  async function post(path: string, request: Record<string, unknown> = {}) {
    const form = new FormData();
    form.append('file', Buffer.from('%PDF source'), { filename: 'source.pdf', contentType: 'application/pdf' });
    form.append('request', JSON.stringify(request));
    return axios.post(baseURL + path, form, { headers: form.getHeaders(), validateStatus: () => true });
  }

  it.each([
    ['headers-footers/add', { regions: { bottomCenter: 'Page <<1>>' } }],
    ['headers-footers/remove', {}],
    ['bates/add', { position: 'bottomRight', startNumber: 1, digits: 6 }],
    ['bates/remove', {}],
  ] as const)('serves synchronous PDF and asynchronous task routes for %s', async (op, request) => {
    const sync = await post(`/api/v1/process/pdf/${op}`, request);
    expect(sync.status).toBe(200);
    expect(sync.headers['content-type']).toContain('application/pdf');
    expect(sync.data).toBe('%PDF result');
    const task = await post(`/api/v1/task/pdf/${op}`, request);
    expect(task.status).toBe(202);
    expect(task.data).toEqual({ code: 200, msg: 'success', data: { taskId: 'task-decoration', status: 'pending' } });
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'pdf', op }), expect.any(Array), null);
  });

  it('wraps read results in the standard JSON success envelope', async () => {
    const header = await post('/api/v1/process/pdf/headers-footers/read');
    expect(header.status).toBe(200);
    expect(header.data).toEqual({ code: 200, msg: 'success', data: { headerFooter: null } });
    const bates = await post('/api/v1/process/pdf/bates/read');
    expect(bates.status).toBe(200);
    expect(bates.data.data).toEqual({ bates: { pages: '0,1' } });
  });

  it('returns local invalid parameters as HTTP 400 without calling the SDK', async () => {
    const callsBefore = sdk.addBates.mock.calls.length;
    const response = await post('/api/v1/process/pdf/bates/add', { position: 'bottomRight', startNumber: 1, digits: 0 });
    expect(response.status).toBe(400);
    expect(response.data).toMatchObject({ type: 'server', code: 100001, errorCode: 'INVALID_ARGUMENT' });
    expect(sdk.addBates).toHaveBeenCalledTimes(callsBefore);
  });

  it('preserves the project HTTP 200 business-error response for missing Bates', async () => {
    sdk.removeBates.mockRejectedValueOnce(new UpstreamSdkError({ source: 'pdf', status: 404, code: 130105, message: 'No Bates found' }));
    const response = await post('/api/v1/process/pdf/bates/remove');
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ type: 'pdf', code: 130105, errorCode: 'BATES_NOT_FOUND' });
  });
});
