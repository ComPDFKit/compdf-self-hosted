import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { validateCompressRequest } from './compression-validation';

describe('validateCompressRequest', () => {
  it.each([-1, 101, 10.5, '', 'not-a-number', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid image quality: %o',
    (imageQuality) => {
      try {
        validateCompressRequest({ imageQuality });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toEqual({
          code: 'INVALID_ARGUMENT',
          message: 'imageQuality must be an integer between 0 and 100.',
        });
      }
    },
  );

  it.each([0, 30, 100, '0', '100'])(
    'accepts an integer image quality inside the inclusive range: %o',
    (imageQuality) => {
      expect(() => validateCompressRequest({ imageQuality })).not.toThrow();
    },
  );

  it('allows imageQuality to be omitted', () => {
    expect(() => validateCompressRequest({ optimizeFlags: ['RMNOTUSE'] })).not.toThrow();
  });
});
