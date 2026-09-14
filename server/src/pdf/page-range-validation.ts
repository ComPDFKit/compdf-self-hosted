import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';

const PAGE_RANGE_EXAMPLE = '1-2,4';

export function validateDeletePagesRequest(request: Record<string, unknown>): void {
  const pageRanges = request.pageRanges;
  if (isEmptyPageSelection(pageRanges) || (Array.isArray(pageRanges) && pageRanges.length === 0)) {
    throw new BadRequestException({
      code: ErrorCode.INVALID_ARGUMENT,
      message: 'pages[] is required',
    });
  }
}

export function validateInsertFromPdfRequest(request: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(request, 'sourcePageRanges')) return;

  const sourcePageRanges = request.sourcePageRanges;
  if (isEmptyPageSelection(sourcePageRanges)) return;

  const rawRanges = Array.isArray(sourcePageRanges) ? sourcePageRanges : [sourcePageRanges];
  const ranges = rawRanges.flatMap((range) => (
    typeof range === 'string'
      ? range.split(/[;,]/).map((part) => part.trim()).filter(Boolean)
      : [range]
  ));
  if (ranges.length === 0 || ranges.some((range) => !isValidOneBasedRange(range))) {
    throw new BadRequestException({
      code: ErrorCode.INVALID_PAGE_RANGE,
      message: `sourcePageRanges must use 1-based page numbers, for example ${PAGE_RANGE_EXAMPLE}.`,
    });
  }
}

function isEmptyPageSelection(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === 'string' && value.trim() === '');
}

function isValidOneBasedRange(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1;
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'all') return true;

  const singlePage = trimmed.match(/^\d+$/);
  if (singlePage) return Number(singlePage[0]) >= 1;

  const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!range) return false;
  const start = Number(range[1]);
  const end = Number(range[2]);
  return start >= 1 && end >= start;
}
