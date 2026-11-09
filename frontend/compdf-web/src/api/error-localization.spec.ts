import { describe, expect, it } from 'vitest';
import { apiErrorTranslationKey } from './error-localization';

describe('conversion error localization', () => {
  it('maps legacy numeric PDF page errors to the localized key', () => {
    expect(apiErrorTranslationKey({ type: 'conversion', code: 4, errorCode: null, message: 'PDF_PAGE_ERROR' })).toBe('pdfPageError');
  });

  it('keeps normalized conversion error codes supported', () => {
    expect(apiErrorTranslationKey({ type: 'conversion', code: 190004, errorCode: null, message: 'PDF_SECURITY_ERROR' })).toBe('pdfSecurityError');
  });
});
