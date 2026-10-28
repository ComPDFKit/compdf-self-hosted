import { describe, expect, it } from 'vitest';
import {
  buildStampRequest,
  defaultStampParameter,
  STAMP_POSITIONS,
  stampValidationKey,
  type StampKind,
  type StampParameter,
  type StampPosition,
} from './stamp-schema';

describe('stamp opacity encoding', () => {
  it.each([[0, '#00396FFA'], [0.5, '#80396FFA'], [1, '#396FFA']] as const)(
    'encodes alpha %s into the SDK ARGB order', (opacity, color) => {
      const parameter = { ...defaultStampParameter('bates'), textColor: '#396FFA', textOpacity: opacity };
      const request = buildStampRequest('bates', parameter);
      expect(request.textColor).toBe(color);
      expect(request).not.toHaveProperty('opacity');
      expect(request).not.toHaveProperty('textOpacity');
    },
  );
  it.each([-0.1, 1.1, '', NaN, Infinity])('rejects invalid alpha %s', (textOpacity) => {
    expect(stampValidationKey('bates', { ...defaultStampParameter('bates'), textOpacity }))
      .toBe('pdfToolDetail.upload.errors.watermarkOpacityInvalid');
  });
});

function validHeaders(): StampParameter {
  const parameter = defaultStampParameter('headers-footers');
  parameter.regions.topCenter = 'Page <<1>>';
  return parameter;
}

describe('stamp defaults and request contract', () => {
  it('defaults to header center, Bates bottom right, and independent nested state', () => {
    const headers = defaultStampParameter('headers-footers');
    const bates = defaultStampParameter('bates');
    expect(headers.position).toBe('topCenter');
    expect(headers.pageOffset).toBe(1);
    expect(bates).toMatchObject({ position: 'bottomRight', pageOffset: 0, startNumber: 1, digits: 6, numberingMode: 'per-file' });
    expect(headers.marginMm).toEqual({ top: 30, bottom: 30, left: 30, right: 30 });
    headers.marginMm.top = 0;
    headers.regions.topCenter = 'Changed';
    expect(bates.marginMm.top).toBe(30);
    expect(defaultStampParameter('headers-footers').regions.topCenter).toBe('');
    expect(stampValidationKey('headers-footers', defaultStampParameter('headers-footers'))).toBe('batchTools.stamp.errors.content');
    expect(stampValidationKey('bates', bates)).toBeNull();
  });

  it('maps header text and exact placeholders without expanding dates or variables', () => {
    const parameter = validHeaders();
    parameter.regions.topLeft = '  Matter A  ';
    parameter.regions.bottomRight = '2026/10/09';
    parameter.regions.bottomCenter = ' \n ';
    parameter.marginMm = { left: '25.4', top: '0', right: 12.7, bottom: '30' };
    parameter.pageRange = 'custom';
    parameter.customPages = ' 1、 3 - 5，8 ';
    parameter.pageOffset = '3';
    parameter.fontSize = '14';
    parameter.fontName = ' Helvetica ';
    const before = structuredClone(parameter);
    const result = buildStampRequest('headers-footers', parameter);
    expect(result).toEqual({
      fontName: 'Helvetica', fontSize: 14, textColor: '#000000',
      margin: { left: 72, top: 0, right: 36, bottom: 30 * 72 / 25.4 },
      pages: '1,3-5,8', pageOffset: 3, rules: 2,
      regions: { topLeft: '  Matter A  ', topCenter: 'Page <<1>>', bottomRight: '2026/10/09' },
    });
    expect(parameter).toEqual(before);
    (result.regions as Record<string, string>).topCenter = 'Other';
    expect(parameter.regions.topCenter).toBe('Page <<1>>');
  });

  it.each(STAMP_POSITIONS)('supports region and Bates position %s', (position) => {
    const headers = defaultStampParameter('headers-footers');
    headers.regions[position] = 'Text';
    expect(buildStampRequest('headers-footers', headers).regions).toEqual({ [position]: 'Text' });
    const bates = defaultStampParameter('bates');
    bates.position = position;
    expect(buildStampRequest('bates', bates).position).toBe(position);
  });

  it('serializes all six populated header regions, not just the editing position', () => {
    const parameter = validHeaders();
    STAMP_POSITIONS.forEach((position) => { parameter.regions[position] = position; });
    expect(buildStampRequest('headers-footers', parameter).regions).toEqual(parameter.regions);
  });

  it('ignores inactive custom pages and page offset when text has no page placeholder', () => {
    const parameter = validHeaders();
    parameter.regions.topCenter = 'Fixed text';
    parameter.pageOffset = '';
    parameter.customPages = 'invalid stale value';
    expect(buildStampRequest('headers-footers', parameter)).toMatchObject({ pages: 'all', pageOffset: 1 });
  });

  it('builds only supported Bates request fields and never leaks UI or batch options', () => {
    const parameter = defaultStampParameter('bates');
    Object.assign(parameter, { password: 'private', opacity: 0.5, totalPages: 99, rules: 1, outputFileName: 'ignored.pdf' });
    parameter.startNumber = '42';
    parameter.digits = '6';
    parameter.prefix = 'CASE-';
    parameter.suffix = '-甲';
    parameter.regions.topLeft = 'Stale header text';
    const result = buildStampRequest('bates', parameter);
    expect(result).toEqual({
      fontName: 'Helvetica', fontSize: 12, textColor: '#000000',
      margin: { left: 30 * 72 / 25.4, top: 30 * 72 / 25.4, right: 30 * 72 / 25.4, bottom: 30 * 72 / 25.4 },
      pages: 'all', position: 'bottomRight', startNumber: 42, digits: 6, prefix: 'CASE-', suffix: '-甲', pageOffset: 0,
    });
    expect(result).not.toHaveProperty('numberingMode');
    expect(result).not.toHaveProperty('options');
  });

  it('whitelists header request fields even if UI state has unrelated properties', () => {
    const parameter = validHeaders();
    Object.assign(parameter, { password: 'private', opacity: 0.5, rules: 1 });
    const request = buildStampRequest('headers-footers', parameter);
    expect(Object.keys(request).sort()).toEqual(['fontName', 'fontSize', 'margin', 'pageOffset', 'pages', 'regions', 'rules', 'textColor']);
    expect(request.rules).toBe(2);
  });
});

describe('shared stamp validation', () => {
  it.each(['1', '1-3', '1,3,5', '1-3,5', '1、3-5、8', '1，3-5', ' 1, 3 - 5 ', '5-5', '999999'])('accepts page syntax %s without claiming document bounds', (customPages) => {
    const parameter = { ...defaultStampParameter('bates'), pageRange: 'custom' as const, customPages };
    expect(stampValidationKey('bates', parameter)).toBeNull();
  });

  it.each(['', ' ', '0', '-1', '3-1', '1,', ',1', '1,,2', '1-2-3', 'all', '1;2', '1.5', '1 2', '1e2', '01', '1-0', '9007199254740992'])('rejects invalid page syntax %s', (customPages) => {
    const parameter = { ...defaultStampParameter('bates'), pageRange: 'custom' as const, customPages };
    expect(stampValidationKey('bates', parameter)).toBe('batchTools.stamp.errors.pages');
  });

  const invalidFields: [Partial<StampParameter>, string][] = [
    [{ pageRange: 'unknown' as StampParameter['pageRange'] }, 'pages'],
    [{ position: 'middle' as StampPosition }, 'position'],
    [{ fontName: '  ' }, 'font'],
    ...[0, 101, -1, 1.5, '', ' ', '1e1', '0x10', NaN, Infinity].map((fontSize): [Partial<StampParameter>, string] => [{ fontSize }, 'fontSize']),
    ...['#fff', '#ff000000', '000000', '#gg0000', 'red', ''].map((textColor): [Partial<StampParameter>, string] => [{ textColor }, 'color']),
  ];
  it.each(invalidFields)('rejects invalid shared fields %j', (patch, error) => {
    for (const kind of ['headers-footers', 'bates'] as StampKind[]) {
      const parameter = { ...validHeaders(), ...patch };
      expect(stampValidationKey(kind, parameter)).toBe(`batchTools.stamp.errors.${error}`);
      expect(() => buildStampRequest(kind, parameter)).toThrow(`batchTools.stamp.errors.${error}`);
    }
  });

  it.each([-1, '', ' ', 'NaN', NaN, Infinity, Number.MAX_VALUE])('rejects invalid margins %s', (value) => {
    const parameter = defaultStampParameter('bates');
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      parameter.marginMm = { top: 30, bottom: 30, left: 30, right: 30, [side]: value };
      expect(stampValidationKey('bates', parameter)).toBe('batchTools.stamp.errors.margins');
    }
  });

  it.each([1, 100, '12'])('accepts supported font-size boundaries %s', (fontSize) => {
    expect(stampValidationKey('bates', { ...defaultStampParameter('bates'), fontSize, textColor: '#aAbB09' })).toBeNull();
  });
});

describe('headers and footers validation', () => {
  it.each(['<<2>>', '<<i>>', '<<1,10>>', '<<date>>', 'Page <<1>> of <<n>>', '<PageNumber>', '<TotalPages>', '<FileName>'])('rejects unsupported variable %s', (text) => {
    const parameter = validHeaders();
    parameter.regions.topLeft = text;
    expect(stampValidationKey('headers-footers', parameter)).toBe('batchTools.stamp.errors.variables');
  });

  it.each([0, -1, 1.5, '', Infinity, 2147483648])('rejects invalid starting page number %s', (pageOffset) => {
    expect(stampValidationKey('headers-footers', { ...validHeaders(), pageOffset })).toBe('batchTools.stamp.errors.pageOffset');
  });

  it('rejects unknown regions and non-text regions', () => {
    const parameter = validHeaders();
    Object.assign(parameter.regions, { middle: 'Unsupported' });
    expect(stampValidationKey('headers-footers', parameter)).toBe('batchTools.stamp.errors.regions');
    const malformed = validHeaders();
    Object.assign(malformed.regions, { bottomLeft: null });
    expect(stampValidationKey('headers-footers', malformed)).toBe('batchTools.stamp.errors.regions');
  });
});

describe('Bates validation', () => {
  it.each([0, -1, 1.5, '', Infinity, 2147483648])('rejects invalid starting number %s', (startNumber) => {
    expect(stampValidationKey('bates', { ...defaultStampParameter('bates'), startNumber })).toBe('batchTools.stamp.errors.startNumber');
  });

  it.each([0, 33, 1.5, '', Infinity])('rejects invalid digits %s', (digits) => {
    expect(stampValidationKey('bates', { ...defaultStampParameter('bates'), digits })).toBe('batchTools.stamp.errors.digits');
  });

  it('checks starting-number width without fabricating the last number of any file', () => {
    const parameter = defaultStampParameter('bates');
    parameter.startNumber = 100;
    parameter.digits = 2;
    expect(stampValidationKey('bates', parameter)).toBe('batchTools.stamp.errors.numberWidth');
    parameter.startNumber = 99;
    expect(stampValidationKey('bates', parameter)).toBeNull();
    parameter.startNumber = 2147483647;
    parameter.digits = 32;
    expect(stampValidationKey('bates', parameter)).toBeNull();
  });

  it.each(['continuous', '', 'unknown'])('rejects unsupported numbering mode %s', (numberingMode) => {
    const parameter = defaultStampParameter('bates');
    Object.assign(parameter, { numberingMode });
    expect(stampValidationKey('bates', parameter)).toBe('batchTools.stamp.errors.numberingMode');
  });

  it.each(['#', '<<1>>', '>>', 'line\nbreak', 'line\rbreak', '\t', '\u0000', '\u007f', '\u202e', 'A'.repeat(33), '甲'.repeat(33)])('rejects unsafe or long affix %j', (value) => {
    for (const field of ['prefix', 'suffix'] as const) {
      const parameter = { ...defaultStampParameter('bates'), [field]: value };
      expect(stampValidationKey('bates', parameter)).toBe(`batchTools.stamp.errors.${field}`);
    }
  });

  it.each(['', 'CASE-123_ A', '案卷-甲_001', '甲'.repeat(32)])('accepts supported affix %s', (value) => {
    expect(stampValidationKey('bates', { ...defaultStampParameter('bates'), prefix: value, suffix: value })).toBeNull();
  });
});
