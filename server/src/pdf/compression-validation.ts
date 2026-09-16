import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';

export const MIN_IMAGE_QUALITY = 0;
export const MAX_IMAGE_QUALITY = 100;

export function validateCompressRequest(request: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(request, 'imageQuality')) return;

  const quality = finiteNumber(request.imageQuality);
  if (quality === null || !Number.isInteger(quality) || quality < MIN_IMAGE_QUALITY || quality > MAX_IMAGE_QUALITY) {
    throw new BadRequestException({
      code: ErrorCode.INVALID_ARGUMENT,
      message: 'imageQuality must be an integer between 0 and 100.',
    });
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
