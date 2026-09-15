import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { PdfSdkClient } from './pdf-sdk.client';

describe('PdfSdkClient add watermark', () => {
  it('forwards the source PDF password in the request JSON', async () => {
    const client = new PdfSdkClient({
      get: vi.fn().mockReturnValue('http://compdf-app:7001'),
    } as unknown as ConfigService);
    const callSync = vi.spyOn(client as any, 'callSync').mockResolvedValue({
      buffer: Buffer.from('%PDF'),
      headers: { 'content-type': 'application/pdf' },
    });
    const file = {
      originalname: 'encrypted.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    };

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
});
