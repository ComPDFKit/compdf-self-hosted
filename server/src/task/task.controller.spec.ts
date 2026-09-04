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
