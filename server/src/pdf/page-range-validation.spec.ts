import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ErrorCode, numericCodeForServerError } from '../common/errors/error-codes';
import { validateDeletePagesRequest, validateInsertFromPdfRequest } from './page-range-validation';

describe('validateDeletePagesRequest', () => {
  it.each([
    {},
    { pageRanges: '' },
    { pageRanges: '   ' },
    { pageRanges: [] },
  ])('rejects an empty page selection: %o', (request) => {
    try {
      validateDeletePagesRequest(request);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        code: 'INVALID_ARGUMENT',
        message: 'pages[] is required',
      });
    }
  });

  it.each([
    { pageRanges: '1' },
    { pageRanges: '1-2,4' },
    { pageRanges: ['1-2', '4'] },
  ])('accepts a non-empty page selection: %o', (request) => {
    expect(() => validateDeletePagesRequest(request)).not.toThrow();
  });
});

describe('validateInsertFromPdfRequest', () => {
  it.each([
    {},
    { sourcePageRanges: '' },
    { sourcePageRanges: 'all' },
    { sourcePageRanges: '1-2,4' },
    { sourcePageRanges: ['1-2', '4'] },
    { sourcePageRanges: [1, '2-3'] },
  ])('accepts a valid 1-based selection: %o', (request) => {
    expect(() => validateInsertFromPdfRequest(request)).not.toThrow();
  });

  it.each([
    { sourcePageRanges: ['0-1'] },
    { sourcePageRanges: ['1-0'] },
    { sourcePageRanges: ['3-1'] },
    { sourcePageRanges: ['1-two'] },
    { sourcePageRanges: [0] },
  ])('rejects an invalid or zero-based selection: %o', (request) => {
    try {
      validateInsertFromPdfRequest(request);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        code: 'INVALID_PAGE_RANGE',
        message: 'sourcePageRanges must use 1-based page numbers, for example 1-2,4.',
      });
    }
  });

  it('maps local invalid page ranges to the public 110001 business code', () => {
    expect(numericCodeForServerError(ErrorCode.INVALID_PAGE_RANGE, 400)).toBe(110001);
  });
});
