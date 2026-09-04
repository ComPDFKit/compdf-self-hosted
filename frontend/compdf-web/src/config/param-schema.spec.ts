import { describe, expect, it } from 'vitest';
import { buildRequest, defaultParameter } from './param-schema';

const pdf = { name: 'sample.pdf' } as File;

describe('PDF to Markdown request payload', () => {
  it('builds every advertised option and keeps the password separate', () => {
    const parameter = defaultParameter();
    parameter.pageRanges = '1-3,5';
    parameter.enableOcr = '1';
    parameter.ocrRecognitionLang = 'ENGLISH';
    parameter.ocrOption = 'SCAN_PAGE';

    const result = buildRequest({
      fromType: 'pdf',
      toType: 'markdown',
      parameter,
      password: 'secret',
      files: [pdf],
    });

    expect(result.field).toBe('options');
    expect(result.passwordField).toBe('separate');
    expect(result.payload).toMatchObject({
      pageRanges: '1-3,5',
      enableAiLayout: '1',
      enableOcr: '1',
      ocrRecognitionLang: 'ENGLISH',
      ocrOption: 'SCAN_PAGE',
      isContainImg: '1',
      isContainAnnot: '1',
      formulaToImage: '0',
      containPageBackgroundImage: '0',
      isOutputDocumentPerPage: '0',
    });
    expect(result.payload).not.toHaveProperty('password');
  });
});
