import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { PdfSdkClient } from './pdf-sdk.client';
import { UpstreamSdkError } from '../common/errors/upstream-sdk.error';
import { ErrorCode } from '../common/errors/error-codes';

const file = {
  originalname: 'encrypted.pdf',
  mimetype: 'application/pdf',
  buffer: Buffer.from('%PDF'),
};

function createClient() {
  const client = new PdfSdkClient({
    get: vi.fn().mockReturnValue('http://compdf-app:7001'),
  } as unknown as ConfigService);
  const callSync = vi.spyOn(client as any, 'callSync').mockResolvedValue({
    buffer: Buffer.from('%PDF'),
    headers: { 'content-type': 'application/pdf' },
  });
  return { client, callSync };
}

describe('PdfSdkClient split', () => {
  it('passes custom ranges unchanged without calling documents/info', async () => {
    const { client, callSync } = createClient();
    const request = Object.freeze({ ranges: ['1-3', '5,7'], password: 'secret', zipFileName: 'custom.zip' });
    await client.split(file, request, 'token');
    expect(callSync).toHaveBeenCalledExactlyOnceWith('/v1/sync/pages/split', [{ fieldname: 'file', ...file }], request, 'token');
    expect(callSync.mock.calls[0][2]).toBe(request);
  });

  it.each(['every', 'equal'])('resolves %s with the same source/password and strips internal options', async (splitMode) => {
    const { client, callSync } = createClient();
    const info = { info: {}, pageCount: 8, majorVersion: 1 };
    callSync.mockResolvedValueOnce({ buffer: Buffer.from(JSON.stringify(info)), headers: {} });
    const result = { buffer: Buffer.from('zip result'), headers: { 'content-type': 'application/zip' } };
    callSync.mockResolvedValueOnce(result);
    const request = Object.freeze({ splitMode, splitCount: 3, password: 'secret', zipFileName: 'parts.zip', outputFileName: 'part.pdf' });
    await expect(client.split(file, request, 'token')).resolves.toBe(result);
    expect(callSync).toHaveBeenCalledTimes(2);
    expect(callSync).toHaveBeenNthCalledWith(1, '/v1/sync/documents/info', [{ fieldname: 'file', ...file }], { password: 'secret' }, 'token');
    expect(callSync).toHaveBeenNthCalledWith(2, '/v1/sync/pages/split', [{ fieldname: 'file', ...file }], {
      ranges: ['1-3', '4-6', '7-8'], password: 'secret', zipFileName: 'parts.zip', outputFileName: 'part.pdf',
    }, 'token');
  });

  it.each([
    { splitMode: 'every', splitCount: 0 },
    { splitMode: 'equal', splitCount: '2' },
    { splitMode: 'every', splitCount: 1.5 },
    { splitMode: 'every', splitCount: Number.MAX_SAFE_INTEGER + 1 },
    { splitMode: 'custom', splitCount: 2 },
    { splitMode: 'equal' },
    { splitCount: 2 },
    { splitMode: 'equal', splitCount: 2, ranges: [] },
  ])('rejects invalid options before any SDK call: %j', async (request) => {
    const { client, callSync } = createClient();
    await expect(client.split(file, request, '')).rejects.toBeInstanceOf(BadRequestException);
    expect(callSync).not.toHaveBeenCalled();
  });

  it('rejects equal splitCount above pageCount before calling split', async () => {
    const { client, callSync } = createClient();
    callSync.mockResolvedValueOnce({ buffer: Buffer.from('{"pageCount":2}'), headers: {} });
    await expect(client.split(file, { splitMode: 'equal', splitCount: 3 }, '')).rejects.toMatchObject({
      response: { code: ErrorCode.INVALID_ARGUMENT },
    });
    expect(callSync).toHaveBeenCalledExactlyOnceWith('/v1/sync/documents/info', expect.any(Array), {}, '');
  });

  it.each(['%PDF', '{"pageCount":0}', '{"pageCount":"2"}', '{"info":{"pageCount":2}}'])('does not split after invalid info: %s', async (body) => {
    const { client, callSync } = createClient();
    callSync.mockResolvedValueOnce({ buffer: Buffer.from(body), headers: {} });
    await expect(client.split(file, { splitMode: 'every', splitCount: 2 }, '')).rejects.toBeInstanceOf(UpstreamSdkError);
    expect(callSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['info', 120001], ['info', 120002], ['split', 120001], ['split', 120002],
  ] as const)('preserves password error from %s: %i', async (stage, code) => {
    const { client, callSync } = createClient();
    if (stage === 'split') callSync.mockResolvedValueOnce({ buffer: Buffer.from('{"pageCount":2}'), headers: {} });
    const error = new UpstreamSdkError({ source: 'pdf', status: 400, code, message: 'SDK password failure', traceId: 'trace' });
    callSync.mockRejectedValueOnce(error);
    await expect(client.split(file, { splitMode: 'every', splitCount: 1, password: 'wrong' }, '')).rejects.toBe(error);
    expect(callSync).toHaveBeenCalledTimes(stage === 'info' ? 1 : 2);
  });

  it('sends multipart file + request JSON to both SDK endpoints', async () => {
    const client = new PdfSdkClient({ get: () => 'http://compdf-app:7001' } as unknown as ConfigService);
    const post = vi.fn()
      .mockResolvedValueOnce({ data: Buffer.from('{"info":{},"pageCount":2,"majorVersion":1}'), headers: {}, status: 200 })
      .mockResolvedValueOnce({ data: Buffer.from('zip result'), headers: { 'content-type': 'application/zip' }, status: 200 });
    (client as any).setHttp({ post });
    await client.split(file, { splitMode: 'every', splitCount: 1, password: 'secret', zipFileName: 'parts.zip' }, '');
    expect(post.mock.calls.map(([path]) => path)).toEqual(['/v1/sync/documents/info', '/v1/sync/pages/split']);
    const requests = [{ password: 'secret' }, { password: 'secret', zipFileName: 'parts.zip', ranges: ['1', '2'] }];
    for (const [i, [, form, config]] of post.mock.calls.entries()) {
      const multipart = form.getBuffer().toString('utf8');
      expect(multipart).toContain('name="request"\r\n\r\n' + JSON.stringify(requests[i]));
      expect(multipart).toContain('name="file"; filename="encrypted.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF');
      expect(multipart).not.toContain('splitMode');
      expect(multipart).not.toContain('splitCount');
      expect(config.responseType).toBe('arraybuffer');
    }
  });
});

describe('PdfSdkClient password forwarding', () => {
  it('forwards the source PDF password when adding a watermark', async () => {
    const { client, callSync } = createClient();

    await client.addWatermark(file, {
      type: 'text',
      text: 'CONFIDENTIAL',
      password: '123',
    }, '');

    expect(callSync).toHaveBeenCalledWith(
      '/v1/sync/watermarks/add',
      [expect.objectContaining({ fieldname: 'file', originalname: 'encrypted.pdf' })],
      expect.objectContaining({ password: '123' }),
      '',
    );
  });

  it('forwards the source PDF password when removing a watermark', async () => {
    const { client, callSync } = createClient();

    await client.removeWatermark(file, {
      mode: 'tagged',
      pages: '',
      password: '123',
    }, '');

    expect(callSync).toHaveBeenCalledWith(
      '/v1/sync/watermarks/remove',
      [expect.objectContaining({ fieldname: 'file', originalname: 'encrypted.pdf' })],
      { mode: 'tagged', password: '123' },
      '',
    );
  });

  it('maps a shared merge password to every source PDF', async () => {
    const { client, callSync } = createClient();
    const secondFile = { ...file, originalname: 'second.pdf' };

    await client.merge([file, secondFile], {
      password: 'shared',
    }, '');

    expect(callSync).toHaveBeenCalledWith(
      '/v1/sync/pages/merge',
      [
        expect.objectContaining({ fieldname: 'files', originalname: 'encrypted.pdf' }),
        expect.objectContaining({ fieldname: 'files', originalname: 'second.pdf' }),
      ],
      { passwords: ['shared', 'shared'] },
      '',
    );
  });

  it('keeps per-file merge passwords when they are provided', async () => {
    const { client, callSync } = createClient();
    const secondFile = { ...file, originalname: 'second.pdf' };

    await client.merge([file, secondFile], {
      password: 'shared',
      passwords: ['first', 'second'],
    }, '');

    expect(callSync).toHaveBeenCalledWith(
      '/v1/sync/pages/merge',
      expect.any(Array),
      { passwords: ['first', 'second'] },
      '',
    );
  });

  it('maps the main PDF password and forwards the inserted PDF password', async () => {
    const { client, callSync } = createClient();
    const insertFile = { ...file, originalname: 'insert.pdf' };

    await client.insertFromPdf(file, insertFile, {
      actionType: 'FROM_PDF',
      password: 'main',
      insertPassword: 'insert',
    }, '');

    expect(callSync).toHaveBeenCalledWith(
      '/v1/sync/pages/insert-from-pdf',
      [
        expect.objectContaining({ fieldname: 'file', originalname: 'encrypted.pdf' }),
        expect.objectContaining({ fieldname: 'insertFile', originalname: 'insert.pdf' }),
      ],
      { targetPassword: 'main', insertPassword: 'insert' },
      '',
    );
  });
});

describe('PdfSdkClient header/footer and Bates contracts', () => {
  it.each([
    ['addHeadersFooters', 'headers-footers/add', { regions: { bottomCenter: 'Page <<1>>' }, pages: '1-3' }],
    ['removeHeadersFooters', 'headers-footers/remove', {}],
    ['addBates', 'bates/add', { position: 'bottomRight', startNumber: 1, digits: 6, prefix: 'CASE-' }],
    ['removeBates', 'bates/remove', {}],
  ] as const)('forwards %s without translating pages or passwords', async (method, op, params) => {
    const { client, callSync } = createClient();
    const request = { ...params, password: 'file-password', outputFileName: 'result.pdf' };
    await client[method](file, request, '');
    expect(callSync).toHaveBeenCalledWith(`/v1/sync/${op}`, [expect.objectContaining({ fieldname: 'file', buffer: file.buffer })], request, '');
  });

  it('serializes decoration parameters into the SDK request string field', async () => {
    const client = new PdfSdkClient({ get: () => 'http://compdf-app:7001' } as unknown as ConfigService);
    const post = vi.fn().mockResolvedValue({ data: Buffer.from('%PDF result'), headers: { 'content-type': 'application/pdf' }, status: 200 });
    (client as any).setHttp({ post });
    const request = { regions: { bottomCenter: 'Page <<1>>' }, password: 'secret' };
    await client.addHeadersFooters(file, request, '');
    const [path, form, config] = post.mock.calls[0];
    expect(path).toBe('/v1/sync/headers-footers/add');
    const multipart = form.getBuffer().toString('utf8');
    expect(multipart).toContain('name="request"\r\n\r\n' + JSON.stringify(request));
    expect(multipart).toContain('name="file"; filename="encrypted.pdf"');
    expect(config.responseType).toBe('arraybuffer');
  });

  it.each([
    ['readHeadersFooters', 'headers-footers', 'headerFooter'],
    ['readBates', 'bates', 'bates'],
  ] as const)('reads %s as JSON and preserves SDK-native zero-based pages', async (method, resource, field) => {
    const { client, callSync } = createClient();
    const body = { [field]: { pages: '0,1,2', pageOffset: 1 } };
    callSync.mockResolvedValue({ buffer: Buffer.from(JSON.stringify(body)), headers: { 'content-type': 'application/json' } });
    expect(await client[method](file, { password: 'secret' }, '')).toEqual(body);
    expect(callSync).toHaveBeenCalledWith(`/v1/sync/${resource}/read`, expect.any(Array), { password: 'secret' }, '');
    callSync.mockResolvedValue({ buffer: Buffer.from(JSON.stringify({ [field]: null })), headers: {} });
    expect(await client[method](file, {}, '')).toEqual({ [field]: null });
  });

  it('does not turn an invalid configuration response into success', async () => {
    const { client, callSync } = createClient();
    callSync.mockResolvedValue({ buffer: Buffer.from('%PDF'), headers: {} });
    await expect(client.readBates(file, {}, '')).rejects.toBeInstanceOf(UpstreamSdkError);
  });

  it.each([120001, 120002, 130104, 130105])('preserves SDK error %i', async (code) => {
    const { client, callSync } = createClient();
    const error = new UpstreamSdkError({ source: 'pdf', status: code >= 130000 ? 404 : 400, code, message: 'SDK failure' });
    callSync.mockRejectedValue(error);
    await expect(client.removeBates(file, {}, '')).rejects.toBe(error);
  });
});
