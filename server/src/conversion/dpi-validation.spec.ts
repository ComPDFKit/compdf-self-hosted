import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../common/errors/error-codes';
import { validatePdfImageOptions } from './dpi-validation';

describe('PDF image DPI validation', () => {
  it.each([
    { dpi: 71 },
    { dpi: 1501 },
    { dpi: '' },
    { dpi: 'not-a-number' },
    { dpi: Number.NaN },
    { dpi: Number.POSITIVE_INFINITY },
    { dpi: true },
    { imageScaling: 71 / 72 },
    { imageScaling: 1501 / 72 },
    { imageScaling: '' },
    { imageScaling: false },
    { dpi: 300, imageScaling: 71 / 72 },
  ])('rejects invalid options: %o', (options) => {
    expect(() => validatePdfImageOptions(options)).toThrow(BadRequestException);
    try {
      validatePdfImageOptions(options);
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toEqual({
        code: ErrorCode.INVALID_REQUEST,
        message: 'DPI must be a number between 72 and 1500.',
      });
    }
  });

  it.each([
    undefined,
    {},
    { dpi: 72 },
    { dpi: 1500 },
    { dpi: '300' },
    { imageScaling: 1 },
    { imageScaling: 1500 / 72 },
    { dpi: 300, imageScaling: 300 / 72 },
  ])('accepts valid or omitted options: %o', (options) => {
    expect(() => validatePdfImageOptions(options)).not.toThrow();
  });
});
