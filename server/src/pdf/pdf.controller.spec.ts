import { BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PdfSdkClient } from '../clients/pdf-sdk.client';
import { PdfController } from './pdf.controller';

describe('PdfController PDF standards conversion', () => {
  it('rejects a multipart request with no source PDF as a bad request', async () => {
    const controller = new PdfController({ convertStandard: vi.fn() } as unknown as PdfSdkClient);
    const req = { body: {} } as Request;

    await expect(controller.pdfa(undefined, req, {} as Response)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forwards the source PDF, ICC profile, and request to the standards endpoint', async () => {
    const convertStandard = vi.fn().mockResolvedValue({
      buffer: Buffer.from('%PDF standardized'),
      headers: { 'content-type': 'application/pdf' },
    });
    const controller = new PdfController({ convertStandard } as unknown as PdfSdkClient);
    const pdf = { originalname: 'sample.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const icc = { originalname: 'sRGB.icc', mimetype: 'application/octet-stream', buffer: Buffer.from('ICC') } as Express.Multer.File;
    const req = { body: { request: '{"standard":"pdfa1b"}' } } as Request;
    const resMock = { set: vi.fn(), status: vi.fn(), send: vi.fn() };
    resMock.status.mockReturnValue(resMock);

    await controller.pdfa({ file: [pdf], iccFile: [icc] }, req, resMock as unknown as Response);

    expect(convertStandard).toHaveBeenCalledWith(pdf, icc, { standard: 'pdfa1b' }, '');
    expect(resMock.set).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(resMock.send).toHaveBeenCalledWith(Buffer.from('%PDF standardized'));
  });
});
