import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { validateAddWatermarkRequest } from './watermark-validation';

function responseOf(request: Record<string, unknown>, imageFile?: Express.Multer.File) {
  try {
    validateAddWatermarkRequest(request, imageFile);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse();
  }
}

describe('validateAddWatermarkRequest', () => {
  it('rejects blank text watermarks with the public error contract', () => {
    expect(responseOf({ type: 'text', text: '' })).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'text is required for a text watermark.',
    });
  });

  it.each([
    [{ opacity: 2 }, 'opacity must be between 0 and 1.'],
    [{ fontSize: 0 }, 'fontSize must be greater than 0.'],
    [{ rotation: Number.NaN }, 'rotation must be a finite number.'],
    [{ horizOffset: Number.POSITIVE_INFINITY }, 'horizOffset must be a finite number.'],
    [{ verticalSpacing: -1 }, 'verticalSpacing must not be negative.'],
  ])('rejects invalid numeric watermark parameters', (request, message) => {
    expect(responseOf(request)).toEqual({ code: 'INVALID_ARGUMENT', message });
  });

  it('rejects an empty image watermark file', () => {
    const image = { size: 0, buffer: Buffer.alloc(0) } as Express.Multer.File;
    expect(responseOf({ type: 'image' }, image)).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'imageFile cannot be empty.',
    });
  });

  it('accepts valid text watermark parameters', () => {
    expect(responseOf({
      type: 'text',
      text: 'Draft',
      opacity: 0.5,
      fontSize: 24,
      rotation: 0,
      horizOffset: 0,
      vertOffset: 0,
      horizontalSpacing: 0,
      verticalSpacing: 12,
    })).toBeNull();
  });
});
