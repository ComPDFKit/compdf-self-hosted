import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';

export const MIN_PDF_IMAGE_DPI = 72;
export const MAX_PDF_IMAGE_DPI = 1500;

const MIN_IMAGE_SCALING = MIN_PDF_IMAGE_DPI / 72;
const MAX_IMAGE_SCALING = MAX_PDF_IMAGE_DPI / 72;

export function validatePdfImageOptions(options?: Record<string, unknown>): void {
  if (!options) return;

  if (Object.prototype.hasOwnProperty.call(options, 'dpi')) {
    const dpi = finiteNumber(options.dpi);
    if (dpi === null || dpi < MIN_PDF_IMAGE_DPI || dpi > MAX_PDF_IMAGE_DPI) {
      throw invalidDpi();
    }
  }

  if (Object.prototype.hasOwnProperty.call(options, 'imageScaling')) {
    const scaling = finiteNumber(options.imageScaling);
    if (scaling === null || scaling < MIN_IMAGE_SCALING || scaling > MAX_IMAGE_SCALING) {
      throw invalidDpi();
    }
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function invalidDpi(): BadRequestException {
  return new BadRequestException({
    code: ErrorCode.INVALID_REQUEST,
    message: 'DPI must be a number between 72 and 1500.',
  });
}
