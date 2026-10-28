import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parseDecorationRequest, validateDecorationRequest } from './decoration-validation';

const header = { regions: { bottomCenter: 'Page <<1>>' } };
const bates = { position: 'bottomRight', startNumber: 1, digits: 6 };

describe('decoration request validation', () => {
  it.each(['headers-footers/add', 'bates/add'])('preserves valid SDK parameters and defaults for %s', (op) => {
    const request = { ...(op.startsWith('bates') ? bates : header), pages: '1-3,5', password: 'secret' };
    const before = structuredClone(request);
    validateDecorationRequest(op, request);
    expect(request).toEqual(before);
  });

  it.each([0, 1, 2])('accepts SDK header/footer rules=%i', (rules) => {
    expect(() => validateDecorationRequest('headers-footers/add', { ...header, rules })).not.toThrow();
  });

  it.each([
    ['headers-footers/add', {}],
    ['headers-footers/add', { regions: {} }],
    ['headers-footers/add', { regions: { topLeft: ' ' } }],
    ['headers-footers/add', { regions: { middle: 'text' } }],
    ['headers-footers/add', { regions: { topLeft: 1 } }],
    ['headers-footers/add', { ...header, rules: '2' }],
    ['headers-footers/add', { ...header, rules: 3 }],
    ['bates/add', { ...bates, position: 'center' }],
    ['bates/add', { ...bates, startNumber: -1 }],
    ['bates/add', { ...bates, startNumber: 1.5 }],
    ['bates/add', { ...bates, startNumber: 2147483648 }],
    ['bates/add', { ...bates, digits: 0 }],
    ['bates/add', { ...bates, digits: 33 }],
    ['bates/add', { ...bates, prefix: 'CASE#' }],
    ['bates/add', { ...bates, suffix: '<<1>>' }],
    ['bates/add', { ...bates, prefix: null }],
    ['bates/add', { ...bates, fontName: ' ' }],
    ['bates/add', { ...bates, fontSize: 0 }],
    ['bates/add', { ...bates, fontSize: Infinity }],
    ['bates/add', { ...bates, margin: { top: -1 } }],
    ['bates/add', { ...bates, margin: { left: NaN } }],
    ['bates/add', { ...bates, textColor: 'black' }],
    ['bates/add', { ...bates, pageOffset: 0.5 }],
  ])('rejects invalid %s parameters: %j', (op, request) => {
    expect(() => validateDecorationRequest(op, request)).toThrow(BadRequestException);
  });

  it.each(['0', '0-3', '3-1', '', '1,,2', 'one', ['1'], 1])('rejects non-1-based page ranges: %j', (pages) => {
    try {
      validateDecorationRequest('bates/add', { ...bates, pages });
      expect.fail('expected page validation to fail');
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'INVALID_PAGE_RANGE' });
    }
  });

  it('accepts supported boundary values and partial margins', () => {
    expect(() => validateDecorationRequest('bates/add', {
      ...bates, startNumber: 2147483647, digits: 32, prefix: 'CASE-', suffix: '',
      textColor: '#FF000000', margin: { right: 0 }, pageOffset: 0, pages: 'all',
    })).not.toThrow();
  });

  it('parses JSON without rewriting page or placeholder values', () => {
    expect(parseDecorationRequest(JSON.stringify(header))).toEqual(header);
    expect(parseDecorationRequest(undefined)).toEqual({});
  });

  it.each(['{', '', 'null', '[]', '1'])('rejects invalid request JSON or nonobjects: %s', (value) => {
    expect(() => parseDecorationRequest(value)).toThrow(BadRequestException);
  });

  it.each(['headers-footers/remove', 'bates/remove', 'headers-footers/read', 'bates/read'])('allows password-only %s', (op) => {
    expect(() => validateDecorationRequest(op, { password: 'secret' })).not.toThrow();
    expect(() => validateDecorationRequest(op, { password: 123 })).toThrow(BadRequestException);
  });
});
