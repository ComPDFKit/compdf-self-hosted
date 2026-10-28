import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';
import { UpstreamSdkError } from '../common/errors/upstream-sdk.error';

export interface DynamicSplitRequest {
  splitMode: 'every' | 'equal';
  splitCount: number;
}

/** Leave SDK-native custom ranges untouched; validate dynamic options before I/O. */
export function validateSplitRequest(request: Record<string, unknown>): DynamicSplitRequest | null {
  if (!Object.hasOwn(request, 'splitMode') && !Object.hasOwn(request, 'splitCount')) return null;
  if (Object.hasOwn(request, 'ranges')) {
    throw new BadRequestException({
      code: ErrorCode.CONFLICTING_ARGUMENTS,
      message: 'ranges cannot be combined with splitMode or splitCount.',
    });
  }
  const { splitMode, splitCount } = request;
  if (splitMode !== 'every' && splitMode !== 'equal') {
    throw new BadRequestException({
      code: ErrorCode.INVALID_ARGUMENT,
      message: 'splitMode must be every or equal.',
    });
  }
  if (typeof splitCount !== 'number' || !Number.isSafeInteger(splitCount) || splitCount < 1) {
    throw new BadRequestException({
      code: ErrorCode.INVALID_ARGUMENT,
      message: 'splitCount must be a positive safe integer.',
    });
  }
  return { splitMode, splitCount };
}

/** documents/info returns raw JSON with a top-level pageCount (no data envelope). */
export function parseSplitPageCount(buffer: Buffer): number {
  try {
    const body = JSON.parse(buffer.toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)
      && typeof body.pageCount === 'number' && Number.isSafeInteger(body.pageCount) && body.pageCount > 0) {
      return body.pageCount;
    }
  } catch {
    // A file attachment or malformed JSON cannot supply a trustworthy page count.
  }
  throw new UpstreamSdkError({
    source: 'pdf', status: 502, code: 190999,
    message: 'PDF SDK returned an invalid documents/info pageCount response.',
  });
}

/** Inputs have been validated by validateSplitRequest and parseSplitPageCount. */
export function buildSplitRanges({ splitMode, splitCount }: DynamicSplitRequest, pageCount: number): string[] {
  if (splitMode === 'equal' && splitCount > pageCount) {
    throw new BadRequestException({
      code: ErrorCode.INVALID_ARGUMENT,
      message: 'splitCount cannot exceed pageCount in equal mode.',
    });
  }
  const parts = splitMode === 'equal' ? splitCount : Math.ceil(pageCount / splitCount);
  const ranges: string[] = [];
  let consumed = 0;
  for (let i = 0; i < parts; i++) {
    const size = splitMode === 'every'
      ? Math.min(splitCount, pageCount - consumed)
      : Math.floor(pageCount / splitCount) + (i < pageCount % splitCount ? 1 : 0);
    const start = consumed + 1;
    const end = consumed + size;
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    consumed = end;
  }
  return ranges;
}
