import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ConversionController } from './conversion.controller';
import type { ConversionService } from './conversion.service';
import { parseFilenameFromHeader } from '../common/utils/filename';

const cases = [
  ['pdf', 'png', '中文报告.pdf', 'images.zip', 'application/zip', '中文报告.zip'],
  ['pdf', 'html', '中文报告.pdf', 'html-bundle.zip', 'application/zip', '中文报告.zip'],
  ['img', 'html', '中文图片.png', 'html-bundle.zip', 'application/zip', '中文图片.zip'],
  ['pdf', 'png', 'report.pdf', undefined, 'application/zip', 'report.zip'],
  ['pdf', 'png', '中文报告.pdf', undefined, 'application/zip', '中文报告.zip'],
  ['pdf', 'png', 'report.pdf', undefined, 'image/jpeg', 'report.jpg'],
  ['pdf', 'docx', 'report.pdf', undefined, 'application/octet-stream', 'report.docx'],
  ['pdf', 'markdown', 'report.pdf', undefined, 'text/markdown', 'report.md'],
  ['docx', 'pdf', 'report.docx', undefined, 'application/pdf', 'report.pdf'],
  ['img', 'xlsx', 'image.png', undefined, 'application/octet-stream', 'image.xlsx'],
  ['pdf', 'docx', '中文报告.pdf', 'result.docx', 'application/octet-stream', '中文报告.docx'],
  ['pdf', 'png', 'report.pdf', 'sdk-images.zip', 'application/zip', 'sdk-images.zip'],
] as const;

describe('conversion output filenames', () => {
  it.each(cases)('%s/%s: %s with upstream %s is named %s / %s', async (source, target, originalname, filename, contentType, expected) => {
    const result = { buffer: Buffer.from('result'), contentType, filename, truncated: false };
    const service = { convert: vi.fn().mockResolvedValue(result), convertByType: vi.fn().mockResolvedValue(result), convertToPdf: vi.fn().mockResolvedValue(result) };
    const controller = new ConversionController(service as unknown as ConversionService);
    const file = { originalname, buffer: Buffer.from('source') } as Express.Multer.File;
    const res = { set: vi.fn(), status: vi.fn(), send: vi.fn() };
    res.status.mockReturnValue(res);
    await controller.convertProcess(source, target, file, { body: {} } as Request, res as unknown as Response);
    const disposition = res.set.mock.calls.find(([name]) => name === 'Content-Disposition')?.[1];
    expect(parseFilenameFromHeader(disposition)).toBe(expected);
    expect(res.send).toHaveBeenCalledWith(result.buffer);
    expect(res.set).toHaveBeenCalledWith('Content-Type', contentType);
  });
});
