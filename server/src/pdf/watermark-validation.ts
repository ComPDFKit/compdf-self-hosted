import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';

export function validateAddWatermarkRequest(
  request: Record<string, unknown>,
  imageFile?: Express.Multer.File,
): void {
  if (request.type === 'text' && (typeof request.text !== 'string' || request.text.trim() === '')) {
    invalidArgument('text is required for a text watermark.');
  }
  if (request.type === 'image') {
    if (!imageFile) invalidArgument('imageFile is required for an image watermark.');
    const imageSize = imageFile?.size ?? imageFile?.buffer?.length ?? 0;
    if (imageSize === 0) invalidArgument('imageFile cannot be empty.');
  }

  validateNumber(request, 'opacity', (value) => value >= 0 && value <= 1, 'opacity must be between 0 and 1.');
  validateNumber(request, 'fontSize', (value) => value > 0, 'fontSize must be greater than 0.');
  validateNumber(request, 'rotation', () => true, 'rotation must be a finite number.');
  validateNumber(request, 'horizOffset', () => true, 'horizOffset must be a finite number.');
  validateNumber(request, 'vertOffset', () => true, 'vertOffset must be a finite number.');
  validateNumber(request, 'horizontalSpacing', (value) => value >= 0, 'horizontalSpacing must not be negative.');
  validateNumber(request, 'verticalSpacing', (value) => value >= 0, 'verticalSpacing must not be negative.');
}

function validateNumber(
  request: Record<string, unknown>,
  field: string,
  predicate: (value: number) => boolean,
  message: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(request, field)) return;
  const value = request[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || !predicate(value)) {
    invalidArgument(message);
  }
}

function invalidArgument(message: string): never {
  throw new BadRequestException({ code: ErrorCode.INVALID_ARGUMENT, message });
}
