import { BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { PdfSdkClient } from '../clients/pdf-sdk.client';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { UpstreamSdkError } from '../common/errors/upstream-sdk.error';
import { PdfController } from './pdf.controller';

const file = { originalname: 'source.pdf', buffer: Buffer.from('%PDF source') } as Express.Multer.File;
const header = { regions: { bottomCenter: 'Page <<1>>' } };
const bates = { position: 'bottomRight', startNumber: 1, digits: 6 };
const mutations = [
  ['addHeadersFooters', header], ['removeHeadersFooters', {}],
  ['addBates', bates], ['removeBates', {}],
] as const;

describe('PdfController decoration endpoints', () => {
  it.each(mutations)('forwards %s and returns a PDF with the requested filename', async (method, params) => {
    const result = { buffer: Buffer.from('%PDF result'), headers: { 'content-type': 'application/pdf' } };
    const sdkCall = vi.fn().mockResolvedValue(result);
    const controller = new PdfController({ [method]: sdkCall } as unknown as PdfSdkClient);
    const request = { ...params, password: 'file-password', outputFileName: 'reviewed.pdf' };
    const res = { set: vi.fn(), status: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller[method](file, { body: { request: JSON.stringify(request) } } as Request, res as unknown as Response);
    expect(sdkCall).toHaveBeenCalledWith(file, request, '');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.set).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('reviewed.pdf'));
    expect(res.send).toHaveBeenCalledWith(result.buffer);
  });

  it.each(['readHeadersFooters', 'readBates'] as const)('returns JSON configuration for %s', async (method) => {
    const data = method === 'readBates' ? { bates: null } : { headerFooter: { pages: '0,1' } };
    const sdkCall = vi.fn().mockResolvedValue(data);
    const controller = new PdfController({ [method]: sdkCall } as unknown as PdfSdkClient);
    expect(await controller[method](file, { body: { request: '{"password":"secret"}' } } as Request)).toEqual(data);
    expect(sdkCall).toHaveBeenCalledWith(file, { password: 'secret' }, '');
  });

  it.each(['addHeadersFooters', 'removeHeadersFooters', 'addBates', 'removeBates', 'readHeadersFooters', 'readBates'] as const)('rejects missing or empty PDFs for %s', async (method) => {
    const sdkCall = vi.fn();
    const controller = new PdfController({ [method]: sdkCall } as unknown as PdfSdkClient);
    for (const missing of [undefined, { ...file, buffer: Buffer.alloc(0) }]) {
      await expect(controller[method](missing as Express.Multer.File, { body: {} } as Request, {} as Response)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(sdkCall).not.toHaveBeenCalled();
  });

  it.each(['{', 'null', '[]'])('does not silently ignore malformed JSON: %s', async (request) => {
    const removeBates = vi.fn();
    const controller = new PdfController({ removeBates } as unknown as PdfSdkClient);
    await expect(controller.removeBates(file, { body: { request } } as Request, {} as Response)).rejects.toBeInstanceOf(BadRequestException);
    expect(removeBates).not.toHaveBeenCalled();
  });

  it.each([[120001, 'PASSWORD_REQUIRED'], [120002, 'INVALID_PASSWORD'], [130104, 'HEADER_FOOTER_NOT_FOUND'], [130105, 'BATES_NOT_FOUND']])('normalizes SDK error %i using the existing business-error contract', (code, errorCode) => {
    const error = new UpstreamSdkError({ source: 'pdf', status: 404, code: code as number, message: 'SDK failure' });
    const response = AllExceptionsFilter.toResponse(error);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ type: 'pdf', code, errorCode });
  });
});
