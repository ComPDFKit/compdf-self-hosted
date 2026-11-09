import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { PdfController } from './pdf.controller';
import type { PdfSdkClient } from '../clients/pdf-sdk.client';
import { parseFilenameFromHeader } from '../common/utils/filename';

const source = (originalname: string) => ({ originalname, buffer: Buffer.from('%PDF source') } as Express.Multer.File);

describe('merge result download identity', () => {
  it.each([undefined, 'attachment; filename="source.pdf"', 'attachment; filename="merged.pdf"'])(
    'returns merged.pdf for either input order with upstream header %s', async (header) => {
      const result = { buffer: Buffer.from('%PDF merged'), headers: { 'content-type': 'application/pdf', 'content-disposition': header } };
      const merge = vi.fn().mockResolvedValue(result);
      const controller = new PdfController({ merge } as unknown as PdfSdkClient);
      const first = source('1006.pdf');
      const second = source('2021年员工旅游补助办法.pdf');
      for (const files of [[first, second], [second, first]]) {
        const res = { set: vi.fn(), status: vi.fn(), send: vi.fn() };
        res.status.mockReturnValue(res);
        await controller.merge(files, { body: { request: '{}' } } as Request, res as unknown as Response);
        const disposition = res.set.mock.calls.find(([name]) => name === 'Content-Disposition')?.[1];
        expect(parseFilenameFromHeader(disposition)).toBe('merged.pdf');
        expect(res.send).toHaveBeenCalledWith(result.buffer);
        expect(merge).toHaveBeenLastCalledWith(files, {}, '');
      }
    },
  );

  it('uses an explicit UTF-8 output name even if the SDK returns a source filename', async () => {
    const merge = vi.fn().mockResolvedValue({ buffer: Buffer.from('%PDF merged'), headers: { 'content-disposition': 'attachment; filename="1006.pdf"' } });
    const controller = new PdfController({ merge } as unknown as PdfSdkClient);
    const res = { set: vi.fn(), status: vi.fn(), send: vi.fn() };
    res.status.mockReturnValue(res);
    await controller.merge([source('a.pdf'), source('b.pdf')], { body: { request: JSON.stringify({ outputFileName: ' 合并结果.pdf ' }) } } as Request, res as unknown as Response);
    expect(parseFilenameFromHeader(res.set.mock.calls.find(([name]) => name === 'Content-Disposition')?.[1])).toBe('合并结果.pdf');
  });
});
