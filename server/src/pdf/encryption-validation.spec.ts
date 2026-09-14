import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { validateEncryptRequest } from './encryption-validation';

describe('validateEncryptRequest', () => {
  it.each([
    {},
    { userPassword: '' },
    { userPassword: '   ' },
    { userPassword: 123456 },
    { ownerPassword: 'owner-only' },
  ])('rejects a missing or invalid user password: %o', (request) => {
    try {
      validateEncryptRequest(request);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        code: 'INVALID_ARGUMENT',
        message: 'userPassword is required for PDF encryption.',
      });
    }
  });

  it('accepts a non-empty user password', () => {
    expect(() => validateEncryptRequest({ userPassword: 'secret' })).not.toThrow();
  });
});
