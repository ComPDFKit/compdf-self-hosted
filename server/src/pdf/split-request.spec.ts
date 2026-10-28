import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../common/errors/error-codes';
import { UpstreamSdkError } from '../common/errors/upstream-sdk.error';
import { buildSplitRanges, parseSplitPageCount, validateSplitRequest } from './split-request';

function expectBadRequest(run: () => unknown, code: ErrorCode) {
  expect(run).toThrow(BadRequestException);
  try {
    run();
  } catch (error) {
    expect((error as BadRequestException).getResponse()).toMatchObject({ code });
  }
}

describe('validateSplitRequest', () => {
  it.each(['every', 'equal'])('accepts %s with a positive safe integer', (splitMode) => {
    expect(validateSplitRequest({ splitMode, splitCount: 2 })).toEqual({ splitMode, splitCount: 2 });
  });

  it.each([undefined, null, 0, -1, 1.5, '2', true, [], {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid splitCount %j', (splitCount) => {
      expectBadRequest(() => validateSplitRequest({ splitMode: 'every', splitCount }), ErrorCode.INVALID_ARGUMENT);
    },
  );

  it.each([undefined, null, '', 'custom', 'EVERY', 1])('rejects invalid splitMode %j', (splitMode) => {
    expectBadRequest(() => validateSplitRequest({ splitMode, splitCount: 2 }), ErrorCode.INVALID_ARGUMENT);
  });

  it.each([[], ['1-2'], null, undefined])('rejects any conflicting ranges field: %j', (ranges) => {
    expectBadRequest(() => validateSplitRequest({ splitMode: 'equal', splitCount: 2, ranges }), ErrorCode.CONFLICTING_ARGUMENTS);
  });

  it('rejects splitCount without splitMode', () => {
    expectBadRequest(() => validateSplitRequest({ splitCount: 2 }), ErrorCode.INVALID_ARGUMENT);
  });

  it('leaves custom ranges and their SDK validation unchanged', () => {
    for (const request of [{ ranges: ['1-3', '7,9'] }, { ranges: [] }, { ranges: 'invalid' }, {}]) {
      expect(validateSplitRequest(request)).toBeNull();
    }
  });
});

describe('parseSplitPageCount', () => {
  it('reads only the top-level pageCount from raw documents/info JSON', () => {
    expect(parseSplitPageCount(Buffer.from(JSON.stringify({ info: { pageCount: 99 }, pageCount: 2, majorVersion: 1 })))).toBe(2);
  });

  it.each([
    '%PDF', '', 'null', '[]', '2', '{}', '{"info":{"pageCount":2}}', '{"data":{"pageCount":2}}',
    ...[0, -1, 2.5, '2', null, true, Number.MAX_SAFE_INTEGER + 1].map((pageCount) => JSON.stringify({ pageCount })),
  ])('rejects an invalid info response: %s', (body) => {
    const run = () => parseSplitPageCount(Buffer.from(body));
    expect(run).toThrow(UpstreamSdkError);
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({ source: 'pdf', status: 502, code: 190999 });
    }
  });
});

describe('buildSplitRanges', () => {
  it.each([
    ['every', 3, 8, ['1-3', '4-6', '7-8']],
    ['every', 3, 6, ['1-3', '4-6']],
    ['every', 1, 3, ['1', '2', '3']],
    ['every', 20, 3, ['1-3']],
    ['every', 1, 1, ['1']],
    ['equal', 3, 8, ['1-3', '4-6', '7-8']],
    ['equal', 3, 7, ['1-3', '4-5', '6-7']],
    ['equal', 3, 6, ['1-2', '3-4', '5-6']],
    ['equal', 3, 3, ['1', '2', '3']],
    ['equal', 1, 8, ['1-8']],
    ['equal', 1, 1, ['1']],
    ['every', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, [`1-${Number.MAX_SAFE_INTEGER}`]],
  ] as const)('%s %i for %i pages', (splitMode, splitCount, pageCount, expected) => {
    expect(buildSplitRanges({ splitMode, splitCount }, pageCount)).toEqual(expected);
  });

  it('rejects equal splitCount greater than pageCount', () => {
    expectBadRequest(() => buildSplitRanges({ splitMode: 'equal', splitCount: 3 }, 2), ErrorCode.INVALID_ARGUMENT);
  });
});
