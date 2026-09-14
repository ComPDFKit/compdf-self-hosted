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

describe('PdfController watermark validation', () => {
  it('rejects a blank text watermark before calling the SDK', async () => {
    const addWatermark = vi.fn();
    const controller = new PdfController({ addWatermark } as unknown as PdfSdkClient);
    const pdf = { originalname: 'sample.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { body: { request: '{"type":"text","text":""}' } } as Request;

    await expect(controller.addWatermark(
      { file: [pdf] },
      req,
      {} as Response,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(addWatermark).not.toHaveBeenCalled();
  });
});

describe('PdfController delete pages filename', () => {
  it('returns a UTF-8 filename derived from the Chinese source name', async () => {
    const deletePages = vi.fn().mockResolvedValue({
      buffer: Buffer.from('%PDF result'),
      headers: { 'content-type': 'application/pdf' },
    });
    const controller = new PdfController({ delete: deletePages } as unknown as PdfSdkClient);
    const pdf = {
      originalname: '模板15(新版).pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    } as Express.Multer.File;
    const req = { body: { request: '{"pageRanges":"1"}' } } as Request;
    const resMock = { set: vi.fn(), status: vi.fn(), send: vi.fn() };
    resMock.status.mockReturnValue(resMock);

    await controller.delete(pdf, req, resMock as unknown as Response);

    const disposition = resMock.set.mock.calls.find(([name]) => name === 'Content-Disposition')?.[1];
    expect(disposition).toContain('filename="15()-deleted-pages.pdf"');
    expect(disposition).toContain("filename*=UTF-8''%E6%A8%A1%E6%9D%BF15%28%E6%96%B0%E7%89%88%29-deleted-pages.pdf");
  });

  it('keeps an explicit Chinese output filename', async () => {
    const deletePages = vi.fn().mockResolvedValue({ buffer: Buffer.from('%PDF result'), headers: {} });
    const controller = new PdfController({ delete: deletePages } as unknown as PdfSdkClient);
    const pdf = { originalname: '模板.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { body: { request: '{"pageRanges":"1","outputFileName":"最终版本.pdf"}' } } as Request;
    const resMock = { set: vi.fn(), status: vi.fn(), send: vi.fn() };
    resMock.status.mockReturnValue(resMock);

    await controller.delete(pdf, req, resMock as unknown as Response);

    const disposition = resMock.set.mock.calls.find(([name]) => name === 'Content-Disposition')?.[1];
    expect(disposition).toContain("filename*=UTF-8''%E6%9C%80%E7%BB%88%E7%89%88%E6%9C%AC.pdf");
  });
});

describe('PdfController delete page range validation', () => {
  it('rejects an empty page range before calling the SDK', async () => {
    const deletePages = vi.fn();
    const controller = new PdfController({ delete: deletePages } as unknown as PdfSdkClient);
    const pdf = { originalname: 'source.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { body: { request: '{"pageRanges":""}' } } as Request;

    await expect(controller.delete(pdf, req, {} as Response)).rejects.toBeInstanceOf(BadRequestException);
    expect(deletePages).not.toHaveBeenCalled();
  });
});

describe('PdfController encrypt validation', () => {
  it('rejects an empty password before calling the SDK', async () => {
    const encrypt = vi.fn();
    const controller = new PdfController({ encrypt } as unknown as PdfSdkClient);
    const pdf = { originalname: 'source.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { body: { request: '{"userPassword":""}' } } as Request;

    await expect(controller.encrypt(pdf, req, {} as Response)).rejects.toBeInstanceOf(BadRequestException);
    expect(encrypt).not.toHaveBeenCalled();
  });
});

describe('PdfController insert-from-pdf page range validation', () => {
  it('rejects a zero-based source range before calling the SDK', async () => {
    const insertFromPdf = vi.fn();
    const controller = new PdfController({ insertFromPdf } as unknown as PdfSdkClient);
    const pdf = { originalname: 'source.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const inserted = { originalname: 'insert.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { body: { request: '{"sourcePageRanges":["0-1"]}' } } as Request;

    await expect(controller.insertFromPdf(
      { file: [pdf], insertFile: [inserted] },
      req,
      {} as Response,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(insertFromPdf).not.toHaveBeenCalled();
  });
});
