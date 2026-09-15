import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { PdfSdkClient } from './pdf-sdk.client';

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
