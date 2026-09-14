import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';

export function validateEncryptRequest(request: Record<string, unknown>): void {
  const userPassword = request.userPassword;
  if (typeof userPassword !== 'string' || userPassword.trim() === '') {
    throw new BadRequestException({
      code: ErrorCode.INVALID_ARGUMENT,
      message: 'userPassword is required for PDF encryption.',
    });
  }
}
