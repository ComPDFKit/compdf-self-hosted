import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';

export const PDF_DECORATION_OPS = new Set([
  'headers-footers/add', 'headers-footers/remove', 'bates/add', 'bates/remove',
]);
const POSITIONS = new Set(['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight']);

export function parseDecorationRequest(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      invalid('request must be a valid JSON object.', ErrorCode.INVALID_JSON);
    }
  }
  if (!isObject(parsed)) invalid('request must be a JSON object.');
  return parsed;
}

export function validateDecorationRequest(op: string, request: Record<string, unknown>): void {
  if (!PDF_DECORATION_OPS.has(op) && op !== 'headers-footers/read' && op !== 'bates/read') return;
  for (const key of ['password', 'outputFileName']) {
    if (request[key] !== undefined && typeof request[key] !== 'string') invalid(`${key} must be a string.`);
  }
  if (!op.endsWith('/add')) return;
  if (request.fontName !== undefined && (typeof request.fontName !== 'string' || !request.fontName.trim())) {
    invalid('fontName must be a nonblank string.');
  }
  if (request.fontSize !== undefined && !finiteNumber(request.fontSize, (v) => v > 0)) {
    invalid('fontSize must be a finite number greater than 0.');
  }
  if (request.textColor !== undefined && (typeof request.textColor !== 'string' || !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(request.textColor))) {
    invalid('textColor must use #RRGGBB or #AARRGGBB.');
  }
  if (request.margin !== undefined) {
    if (!isObject(request.margin)) invalid('margin must be an object.');
    for (const [key, value] of Object.entries(request.margin)) {
      if (!['left', 'top', 'right', 'bottom'].includes(key) || !finiteNumber(value, (v) => v >= 0)) {
        invalid('margin must contain only nonnegative finite left/top/right/bottom values.');
      }
    }
  }
  if (request.pageOffset !== undefined && !integerInRange(request.pageOffset, 0, Number.MAX_SAFE_INTEGER)) {
    invalid('pageOffset must be a nonnegative safe integer.');
  }
  if (request.pages !== undefined && !validPages(request.pages)) {
    invalid('pages must be all or a 1-based page range such as 1-3,5.', ErrorCode.INVALID_PAGE_RANGE);
  }
  if (op === 'headers-footers/add') {
    if (!isObject(request.regions) || !Object.keys(request.regions).length) invalid('regions is required.');
    let hasText = false;
    for (const [key, value] of Object.entries(request.regions)) {
      if (!POSITIONS.has(key) || typeof value !== 'string') invalid('regions must use the six supported positions and string values.');
      hasText ||= value.trim().length > 0;
    }
    if (!hasText) invalid('regions must contain at least one nonblank string.');
    if (request.rules !== undefined && ![0, 1, 2].includes(request.rules as number)) {
      invalid('rules must be 0, 1, or 2.');
    }
    return;
  }
  if (typeof request.position !== 'string' || !POSITIONS.has(request.position)) invalid('position must be one of the six supported positions.');
  if (!integerInRange(request.startNumber, 0, 2147483647)) invalid('startNumber must be an integer between 0 and 2147483647.');
  if (!integerInRange(request.digits, 1, 32)) invalid('digits must be an integer between 1 and 32.');
  for (const key of ['prefix', 'suffix']) {
    const value = request[key];
    if (value !== undefined && (typeof value !== 'string' || /#|<<|>>/.test(value))) {
      invalid(`${key} must be a string without #, <<, or >>.`);
    }
  }
}

function validPages(value: unknown): boolean {
  if (value === 'all') return true;
  if (typeof value !== 'string' || !value.trim()) return false;
  return value.split(',').every((part) => {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!match) return false;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    return integerInRange(start, 1, Number.MAX_SAFE_INTEGER) && integerInRange(end, start, Number.MAX_SAFE_INTEGER);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, predicate: (v: number) => boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value) && predicate(value);
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return finiteNumber(value, (v) => Number.isSafeInteger(v) && v >= min && v <= max);
}

function invalid(message: string, code = ErrorCode.INVALID_ARGUMENT): never {
  throw new BadRequestException({ code, message });
}
