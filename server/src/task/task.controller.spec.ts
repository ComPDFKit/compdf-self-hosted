import { BadRequestException } from '@nestjs/common';
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

describe('TaskController watermark validation', () => {
  it('rejects a blank text watermark before creating a task', async () => {
    const create = vi.fn();
    const controller = new TaskController({ create } as unknown as TaskService);
    const pdf = { originalname: 'sample.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { apiKeyId: 'key-1' } as unknown as Request;

    await expect(controller.create(
      'pdf',
      'watermark/add',
      { request: '{"type":"text","text":""}' },
      { file: [pdf] },
      req,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TaskController insert-from-pdf page range validation', () => {
  it('rejects a zero-based source range before creating a task', async () => {
    const create = vi.fn();
    const controller = new TaskController({ create } as unknown as TaskService);
    const pdf = { originalname: 'source.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const inserted = { originalname: 'insert.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { apiKeyId: 'key-1' } as unknown as Request;

    await expect(controller.create(
      'pdf',
      'insert-from-pdf',
      { request: '{"sourcePageRanges":["0-1"]}' },
      { file: [pdf], insertFile: [inserted] },
      req,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TaskController delete page range validation', () => {
  it('rejects an empty page range before creating a task', async () => {
    const create = vi.fn();
    const controller = new TaskController({ create } as unknown as TaskService);
    const pdf = { originalname: 'source.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { apiKeyId: 'key-1' } as unknown as Request;

    await expect(controller.create(
      'pdf',
      'delete',
      { request: '{"pageRanges":""}' },
      { file: [pdf] },
      req,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TaskController encrypt validation', () => {
  it('rejects an empty password before creating a task', async () => {
    const create = vi.fn();
    const controller = new TaskController({ create } as unknown as TaskService);
    const pdf = { originalname: 'source.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { apiKeyId: 'key-1' } as unknown as Request;

    await expect(controller.create(
      'pdf',
      'encrypt',
      { request: '{"userPassword":""}' },
      { file: [pdf] },
      req,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TaskController PDF image DPI validation', () => {
  it('rejects an out-of-range DPI before creating a task', async () => {
    const create = vi.fn();
    const controller = new TaskController({ create } as unknown as TaskService);
    const pdf = { originalname: 'source.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { apiKeyId: 'key-1' } as unknown as Request;

    await expect(controller.create(
      'pdf',
      'png',
      { options: JSON.stringify({ imageScaling: 1501 / 72 }) },
      { file: [pdf] },
      req,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TaskController compression validation', () => {
  it('rejects an out-of-range image quality before creating a task', async () => {
    const create = vi.fn();
    const controller = new TaskController({ create } as unknown as TaskService);
    const pdf = { originalname: 'source.pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const req = { apiKeyId: 'key-1' } as unknown as Request;

    await expect(controller.create(
      'pdf',
      'compress',
      { request: '{"imageQuality":101}' },
      { file: [pdf] },
      req,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});
