/** Shared stamp form state and pure SDK request mapping. No file inspection or network. */
export type StampKind = 'headers-footers' | 'bates';

export const STAMP_POSITIONS = [
  'topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight',
] as const;
export type StampPosition = typeof STAMP_POSITIONS[number];
export type StampNumber = number | string;
export type StampMargin = 'top' | 'bottom' | 'left' | 'right';

export interface StampParameter {
  pageRange: 'all' | 'custom';
  customPages: string;
  /** Current editing region for headers/footers; output position for Bates. */
  position: StampPosition;
  regions: Record<StampPosition, string>;
  fontName: string;
  fontSize: StampNumber;
  textColor: string;
  /** UI alpha, encoded into the SDK's #AARRGGBB textColor when below 1. */
  textOpacity: StampNumber;
  marginMm: Record<StampMargin, StampNumber>;
  pageOffset: StampNumber;
  startNumber: StampNumber;
  digits: StampNumber;
  prefix: string;
  suffix: string;
  /** Batch callers must send options.numberingMode separately from request. */
  numberingMode: 'per-file';
}

export function defaultStampParameter(kind: StampKind): StampParameter {
  return {
    pageRange: 'all',
    customPages: '',
    position: kind === 'bates' ? 'bottomRight' : 'topCenter',
    regions: { topLeft: '', topCenter: '', topRight: '', bottomLeft: '', bottomCenter: '', bottomRight: '' },
    fontName: 'Helvetica',
    fontSize: 12,
    textColor: '#000000',
    textOpacity: 1,
    marginMm: { top: 30, bottom: 30, left: 30, right: 30 },
    pageOffset: kind === 'bates' ? 0 : 1,
    startNumber: 1,
    digits: 6,
    prefix: '',
    suffix: '',
    numberingMode: 'per-file',
  };
}

function numeric(value: StampNumber): number {
  if (typeof value === 'number') return value;
  // Do not accept empty strings, exponents, or JS-specific hex syntax from text inputs.
  return /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
}

function positiveInteger(value: StampNumber, maximum = Number.MAX_SAFE_INTEGER): boolean {
  const number = numeric(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum;
}

function normalizedPages(value: string): string {
  return value.trim().replace(/[、，]/g, ',').replace(/\s*([,-])\s*/g, '$1');
}

function validPages(value: string): boolean {
  return normalizedPages(value).split(',').every((part) => {
    if (!/^[1-9]\d*(?:-[1-9]\d*)?$/.test(part)) return false;
    const [first, last = first] = part.split('-').map(Number);
    return Number.isSafeInteger(first) && Number.isSafeInteger(last) && last! >= first!;
  });
}

function usesPageNumber(parameter: StampParameter): boolean {
  return STAMP_POSITIONS.some((position) => parameter.regions[position].includes('<<1>>'));
}

/** Validates shared syntax only; page bounds and available page area require the SDK. */
export function stampValidationKey(kind: StampKind, parameter: StampParameter): string | null {
  if (parameter.pageRange !== 'all' && parameter.pageRange !== 'custom') {
    return 'batchTools.stamp.errors.pages';
  }
  if (parameter.pageRange === 'custom' && !validPages(parameter.customPages)) {
    return 'batchTools.stamp.errors.pages';
  }
  if (!STAMP_POSITIONS.includes(parameter.position)) return 'batchTools.stamp.errors.position';
  if (!parameter.fontName.trim()) return 'batchTools.stamp.errors.font';
  if (!positiveInteger(parameter.fontSize, 100)) return 'batchTools.stamp.errors.fontSize';
  if (!/^#[\da-f]{6}$/i.test(parameter.textColor)) return 'batchTools.stamp.errors.color';
  const opacity = numeric(parameter.textOpacity);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return 'pdfToolDetail.upload.errors.watermarkOpacityInvalid';
  if ((['top', 'bottom', 'left', 'right'] as const).some((side) => {
    const mm = numeric(parameter.marginMm[side]);
    return !Number.isFinite(mm) || mm < 0 || !Number.isFinite(mm * 72 / 25.4);
  })) return 'batchTools.stamp.errors.margins';

  if (kind === 'headers-footers') {
    if (Object.keys(parameter.regions).some((key) => !STAMP_POSITIONS.includes(key as StampPosition))
      || STAMP_POSITIONS.some((position) => typeof parameter.regions[position] !== 'string')) {
      return 'batchTools.stamp.errors.regions';
    }
    if (!STAMP_POSITIONS.some((position) => parameter.regions[position].trim())) {
      return 'batchTools.stamp.errors.content';
    }
    if (STAMP_POSITIONS.some((position) => {
      const literal = parameter.regions[position].replaceAll('<<1>>', '');
      return /<<|>>|<(?:PageNumber|TotalPages|FileName)>/i.test(literal);
    })) return 'batchTools.stamp.errors.variables';
    if (usesPageNumber(parameter) && !positiveInteger(parameter.pageOffset, 2147483647)) {
      return 'batchTools.stamp.errors.pageOffset';
    }
  } else {
    if (parameter.numberingMode !== 'per-file') return 'batchTools.stamp.errors.numberingMode';
    if (!positiveInteger(parameter.startNumber, 2147483647)) return 'batchTools.stamp.errors.startNumber';
    if (!positiveInteger(parameter.digits, 32)) return 'batchTools.stamp.errors.digits';
    if (String(numeric(parameter.startNumber)).length > numeric(parameter.digits)) {
      return 'batchTools.stamp.errors.numberWidth';
    }
    for (const field of ['prefix', 'suffix'] as const) {
      const value = parameter[field];
      if (Array.from(value).length > 32 || !/^[\p{L}\p{N} _-]*$/u.test(value)) {
        return `batchTools.stamp.errors.${field}`;
      }
    }
  }
  return null;
}

/**
 * Returns only the common batch `request` object. For Bates the caller MUST also
 * pass `options: { numberingMode: 'per-file' }` to batch creation. Passwords belong
 * to each uploaded file. No page-count inference or cross-file numbering occurs.
 * Invalid form state throws the same translation key returned by the validator.
 */
export function buildStampRequest(kind: StampKind, parameter: StampParameter): Record<string, unknown> {
  const error = stampValidationKey(kind, parameter);
  if (error) throw new Error(error);

  const request: Record<string, unknown> = {
    fontName: parameter.fontName.trim(),
    fontSize: numeric(parameter.fontSize),
    textColor: numeric(parameter.textOpacity) === 1 ? parameter.textColor
      : `#${Math.round(numeric(parameter.textOpacity) * 255).toString(16).padStart(2, '0').toUpperCase()}${parameter.textColor.slice(1)}`,
    margin: Object.fromEntries(
      (['left', 'top', 'right', 'bottom'] as const).map((side) => [side, numeric(parameter.marginMm[side]) * 72 / 25.4]),
    ),
    pages: parameter.pageRange === 'all' ? 'all' : normalizedPages(parameter.customPages),
  };

  if (kind === 'headers-footers') {
    request.regions = Object.fromEntries(
      STAMP_POSITIONS.filter((position) => parameter.regions[position].trim())
        .map((position) => [position, parameter.regions[position]]),
    );
    request.rules = 2;
    request.pageOffset = usesPageNumber(parameter) ? numeric(parameter.pageOffset) : 1;
  } else {
    request.position = parameter.position;
    request.startNumber = numeric(parameter.startNumber);
    request.digits = numeric(parameter.digits);
    request.prefix = parameter.prefix;
    request.suffix = parameter.suffix;
    request.pageOffset = 0;
  }
  return request;
}
