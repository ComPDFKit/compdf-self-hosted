import { describe, expect, it } from 'vitest';
import { contentDispositionAttachment, processedFilename } from './filename';

describe('processedFilename', () => {
  it('preserves a Chinese source name and appends the operation marker', () => {
    expect(processedFilename('模板15(新版).pdf', 'deleted-pages')).toBe(
      '模板15(新版)-deleted-pages.pdf',
    );
  });

  it('uses the default extension when the source has none', () => {
    expect(processedFilename('模板15', 'deleted-pages')).toBe(
      '模板15-deleted-pages.pdf',
    );
  });
});

describe('contentDispositionAttachment', () => {
  it('includes an ASCII fallback and an RFC 5987 UTF-8 filename', () => {
    const disposition = contentDispositionAttachment('模板15(新版)-deleted-pages.pdf');

    expect(disposition).toContain('filename="15()-deleted-pages.pdf"');
    expect(disposition).toContain(
      "filename*=UTF-8''%E6%A8%A1%E6%9D%BF15%28%E6%96%B0%E7%89%88%29-deleted-pages.pdf",
    );
  });
});
