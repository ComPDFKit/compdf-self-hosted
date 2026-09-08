import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { TaskController } from './task.controller';
import type { TaskService } from './task.service';

describe('TaskController PDF to Markdown', () => {
  it('creates an async conversion task with type=pdf/markdown', async () => {
    const create = vi.fn().mockResolvedValue({ taskId: 'task-1' });
    const controller = new TaskController({ create } as unknown as TaskService);
    const file = {
      originalname: 'sample.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    } as Express.Multer.File;
    const req = { apiKeyId: 'key-1' } as unknown as Request;

    const result = await controller.create(
      'pdf',
      'markdown',
      { options: '{"pageRanges":"1-2"}', password: 'secret' },
      { file: [file] },
      req,
    );

    expect(create).toHaveBeenCalledWith({
      kind: 'conversion',
      op: 'convert',
      type: 'pdf/markdown',
      options: '{"pageRanges":"1-2"}',
      password: 'secret',
    }, [file], 'key-1');
    expect(result).toEqual({ taskId: 'task-1', status: 'pending' });
  });
});

describe('TaskController PDF standards conversion', () => {
  it('creates an async PDF/A task with the source PDF and ICC profile', async () => {
    const create = vi.fn().mockResolvedValue({ taskId: 'task-pdfa' });
    const controller = new TaskController({ create } as unknown as TaskService);
    const pdf = { originalname: 'sample.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const icc = { originalname: 'sRGB.icc', buffer: Buffer.from('ICC') } as Express.Multer.File;
    const req = { apiKeyId: 'key-1' } as unknown as Request;

    const result = await controller.create(
      'pdf',
      'pdfa',
      { request: '{"standard":"pdfa1b"}' },
      { file: [pdf], iccFile: [icc] },
      req,
    );

    expect(create).toHaveBeenCalledWith({
      kind: 'pdf',
      op: 'pdfa',
      request: '{"standard":"pdfa1b"}',
    }, [pdf, icc], 'key-1');
    expect(result).toEqual({ taskId: 'task-pdfa', status: 'pending' });
  });
});
