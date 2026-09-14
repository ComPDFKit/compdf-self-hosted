import type { Request, Response } from 'express';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ConversionController } from './conversion.controller';
import type { ConversionService } from './conversion.service';

describe('ConversionController PDF to Markdown', () => {
  it('routes the sync process endpoint through type=pdf/markdown', async () => {
    const convertByType = vi.fn().mockResolvedValue({
      buffer: Buffer.from('# Markdown'),
      truncated: false,
      filename: 'sample.md',
      contentType: 'text/markdown',
    });
    const controller = new ConversionController({ convertByType } as unknown as ConversionService);
    const file = {
      originalname: 'sample.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    } as Express.Multer.File;
    const req = {
      body: { options: JSON.stringify({ pageRanges: '1-2' }), password: 'secret' },
    } as unknown as Request;
    const resMock = {
      set: vi.fn(),
      status: vi.fn(),
      send: vi.fn(),
      once: vi.fn(),
      statusCode: 200,
      writableEnded: false,
      writableFinished: false,
    };
    resMock.status.mockReturnValue(resMock);
    resMock.once.mockReturnValue(resMock);

    await controller.convertProcess('pdf', 'markdown', file, req, resMock as unknown as Response);

    expect(convertByType).toHaveBeenCalledWith(file, 'pdf/markdown', '', { pageRanges: '1-2' }, 'secret');
    expect(resMock.set).toHaveBeenCalledWith('Content-Type', 'text/markdown');
    expect(resMock.set).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('sample.md'));
    expect(resMock.send).toHaveBeenCalledWith(Buffer.from('# Markdown'));
  });
});

describe('ConversionController PDF image DPI validation', () => {
  it('rejects an out-of-range DPI before calling the conversion service', async () => {
    const convert = vi.fn();
    const controller = new ConversionController({ convert } as unknown as ConversionService);
    const file = {
      originalname: 'sample.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    } as Express.Multer.File;
    const req = {
      body: { options: JSON.stringify({ imageScaling: 71 / 72 }) },
    } as unknown as Request;

    await expect(controller.convertProcess(
      'pdf',
      'png',
      file,
      req,
      {} as Response,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(convert).not.toHaveBeenCalled();
  });
});
