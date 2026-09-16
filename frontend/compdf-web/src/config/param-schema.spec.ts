import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  compressImageQualityValidationKey,
  CONVERSION_FEATURES,
  defaultParameter,
  deletePageRangeValidationKey,
  encryptPasswordValidationKey,
  imageDpiValidationKey,
  insertSourcePageRangeValidationKey,
  watermarkValidationKey,
} from './param-schema';

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

describe('AI layout analysis', () => {
  it.each([
    ['pdf/docx', 'docx'],
    ['pdf/json', 'json'],
    ['pdf/html', 'html'],
    ['pdf/csv', 'csv'],
    ['pdf/xlsx', 'xlsx'],
    ['pdf/txt', 'txt'],
    ['pdf/pptx', 'pptx'],
    ['pdf/png', 'png'],
    ['pdf/rtf', 'rtf'],
    ['pdf/searchablePdf', 'searchablePdf'],
    ['pdf/ofd', 'ofd'],
  ])('advertises and sends the option for %s', (featureKey, toType) => {
    const parameter = defaultParameter();
    parameter.enableAiLayout = '0';

    const result = buildRequest({
      fromType: 'pdf',
      toType,
      parameter,
      password: '',
      files: [pdf],
    });

    expect(CONVERSION_FEATURES[featureKey]?.aiLayout).toBe(true);
    expect(result.payload.enableAiLayout).toBe('0');
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

describe('watermark parameter validation', () => {
  it('requires non-blank text for a text watermark', () => {
    const parameter = defaultParameter();
    parameter.watermarkText = '   ';

    expect(watermarkValidationKey(parameter)).toBe(
      'pdfToolDetail.upload.errors.watermarkTextRequired',
    );
  });

  it.each([
    ['watermarkOpacity', '1.1', 'pdfToolDetail.upload.errors.watermarkOpacityInvalid'],
    ['watermarkFontSize', '0', 'pdfToolDetail.upload.errors.watermarkFontSizeInvalid'],
    ['watermarkRotation', 'not-a-number', 'pdfToolDetail.upload.errors.watermarkPositionInvalid'],
    ['watermarkHorizontalSpacing', '-1', 'pdfToolDetail.upload.errors.watermarkSpacingInvalid'],
  ] as const)('rejects invalid %s', (field, value, expectedKey) => {
    const parameter = defaultParameter();
    parameter.watermarkText = 'Draft';
    parameter[field] = value;

    expect(watermarkValidationKey(parameter)).toBe(expectedKey);
  });

  it('accepts valid text watermark parameters', () => {
    const parameter = defaultParameter();
    parameter.watermarkText = 'Draft';
    parameter.watermarkFontSize = '24';
    parameter.watermarkHorizontalSpacing = '0';
    parameter.watermarkVerticalSpacing = '12';

    expect(watermarkValidationKey(parameter)).toBeNull();
  });
});

describe('add watermark request payload', () => {
  it('includes the source PDF password in the request JSON', () => {
    const parameter = defaultParameter();
    parameter.watermarkText = 'CONFIDENTIAL';

    const result = buildRequest({
      fromType: 'pdf',
      toType: 'addWatermark',
      parameter,
      password: '123',
      files: [pdf],
    });

    expect(result.field).toBe('request');
    expect(result.passwordField).toBe('inline');
    expect(result.payload.password).toBe('123');
  });
});

describe('PDF edit password payloads', () => {
  it('includes the source PDF password when removing a watermark', () => {
    const result = buildRequest({
      fromType: 'pdf',
      toType: 'removeWatermark',
      parameter: defaultParameter(),
      password: 'source-secret',
      files: [pdf],
    });

    expect(result.payload.password).toBe('source-secret');
  });

  it('builds per-file passwords for merge using the shared password as fallback', () => {
    const parameter = defaultParameter();
    parameter.mergePasswords = ['', 'second-secret'];
    const secondPdf = { name: 'second.pdf' } as File;

    const result = buildRequest({
      fromType: 'pdf',
      toType: 'merge',
      parameter,
      password: 'shared-secret',
      files: [pdf, secondPdf],
    });

    expect(result.payload.passwords).toEqual(['shared-secret', 'second-secret']);
  });

  it('uses separate target and inserted PDF passwords for page insertion', () => {
    const parameter = defaultParameter();
    parameter.insertActionType = 'FROM_PDF';
    parameter.insertTargetPassword = 'insert-secret';
    const insertFile = { name: 'insert.pdf' } as File;

    const result = buildRequest({
      fromType: 'pdf',
      toType: 'insert',
      parameter,
      password: 'target-secret',
      files: [pdf],
      insertTargetFile: insertFile,
    });

    expect(result.payload).toMatchObject({
      targetPassword: 'target-secret',
      insertPassword: 'insert-secret',
    });
    expect(result.extraFiles).toEqual([insertFile]);
  });
});

describe('delete pages output filename', () => {
  it('preserves a Chinese source name and adds the processing suffix', () => {
    const parameter = defaultParameter();
    const source = { name: '模板15(新版).pdf' } as File;

    const result = buildRequest({
      fromType: 'pdf',
      toType: 'delete',
      parameter,
      password: '',
      files: [source],
    });

    expect(result.payload.outputFileName).toBe('模板15(新版)-deleted-pages.pdf');
  });

  it('keeps an explicitly supplied output filename', () => {
    const parameter = defaultParameter();
    parameter.outputFileName = '最终版本.pdf';

    const result = buildRequest({
      fromType: 'pdf',
      toType: 'delete',
      parameter,
      password: '',
      files: [{ name: '模板.pdf' } as File],
    });

    expect(result.payload.outputFileName).toBe('最终版本.pdf');
  });
});

describe('insert source page range validation', () => {
  it.each(['', 'all', '1', '1-2', '1-2,4', '1-2;4-5'])(
    'accepts a valid 1-based value: %s',
    (value) => {
      expect(insertSourcePageRangeValidationKey(value)).toBeNull();
    },
  );

  it.each(['0', '0-1', '1-0', '3-1', '1-two'])(
    'rejects an invalid or zero-based value: %s',
    (value) => {
      expect(insertSourcePageRangeValidationKey(value)).toBe(
        'pdfToolDetail.upload.errors.insertSourcePagesInvalid',
      );
    },
  );
});

describe('delete page range validation', () => {
  it.each(['', '   '])('rejects an empty value: %o', (value) => {
    expect(deletePageRangeValidationKey(value)).toBe(
      'pdfToolDetail.upload.errors.deletePageRangeRequired',
    );
  });

  it.each(['1', '1-2,4'])('accepts a non-empty value: %s', (value) => {
    expect(deletePageRangeValidationKey(value)).toBeNull();
  });
});

describe('encrypt password validation', () => {
  it.each(['', '   '])('rejects an empty value: %o', (value) => {
    expect(encryptPasswordValidationKey(value)).toBe(
      'pdfToolDetail.upload.errors.encryptPasswordRequired',
    );
  });

  it('accepts a non-empty password', () => {
    expect(encryptPasswordValidationKey('secret')).toBeNull();
  });
});

describe('PDF image DPI validation', () => {
  it.each([71, 1501, '', 'not-a-number', Number.NaN, Number.POSITIVE_INFINITY, true, null, undefined])(
    'rejects an invalid DPI value: %o',
    (value) => {
      expect(imageDpiValidationKey(value)).toBe(
        'pdfToolDetail.upload.errors.imageDpiInvalid',
      );
    },
  );

  it.each([72, 300, 1500, '72', '1500'])(
    'accepts a DPI value inside the inclusive range: %o',
    (value) => {
      expect(imageDpiValidationKey(value)).toBeNull();
    },
  );
});

describe('compression image quality validation', () => {
  it.each([-1, 101, '10.5', '', 'not-a-number'])('rejects an invalid custom quality: %o', (value) => {
    const parameter = defaultParameter();
    parameter.compressQuality = 'custom';
    parameter.compressImageQuality = String(value);

    expect(compressImageQualityValidationKey(parameter)).toBe(
      'pdfToolDetail.upload.errors.compressImageQualityInvalid',
    );
  });

  it.each(['0', '30', '100'])('accepts a valid custom quality: %s', (value) => {
    const parameter = defaultParameter();
    parameter.compressQuality = 'custom';
    parameter.compressImageQuality = value;

    expect(compressImageQualityValidationKey(parameter)).toBeNull();
  });

  it('does not validate the hidden custom value for a preset', () => {
    const parameter = defaultParameter();
    parameter.compressQuality = 'medium';
    parameter.compressImageQuality = '101';

    expect(compressImageQualityValidationKey(parameter)).toBeNull();
  });
});
