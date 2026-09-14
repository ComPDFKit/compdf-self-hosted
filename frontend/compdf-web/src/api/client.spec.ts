// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { parseContentDispositionFilename } from './client';

describe('Content-Disposition filename parsing', () => {
  it('prefers the UTF-8 filename over the ASCII fallback', () => {
    const disposition = 'attachment; filename="15()-deleted-pages.pdf"; '
      + "filename*=UTF-8''%E6%A8%A1%E6%9D%BF15%28%E6%96%B0%E7%89%88%29-deleted-pages.pdf";

    expect(parseContentDispositionFilename(disposition)).toBe(
      '模板15(新版)-deleted-pages.pdf',
    );
  });
});
