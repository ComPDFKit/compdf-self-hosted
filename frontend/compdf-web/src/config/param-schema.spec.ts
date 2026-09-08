import { describe, expect, it } from 'vitest';
import { buildRequest, defaultParameter } from './param-schema';

const pdf = { name: 'sample.pdf' } as File;

describe('PDF standards request payload', () => {
  it('builds SDK enum values, metadata, filename, and inline password', () => {
    const parameter = defaultParameter();
    parameter.pdfStandard = 'pdfua1';
    parameter.outputTitle = 'Accessible report';
    parameter.outputLanguage = 'en_US';
    parameter.outputFileName = 'report.pdf';

    const result = buildRequest({
      fromType: 'pdf',
      toType: 'pdfa',
      parameter,
      password: 'secret',
      files: [pdf],
    });

    expect(result.field).toBe('request');
    expect(result.passwordField).toBe('inline');
    expect(result.payload).toEqual({
      standard: 'pdfua1',
      outputFileName: 'report.pdf',
      uaConfig: { title: 'Accessible report', language: 'en_US' },
      password: 'secret',
    });
  });
});

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
