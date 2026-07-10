import { describe, expect, it } from 'vitest';
import { TOOL_SECTIONS, resolveTool, resolveConversionTypes } from './convert-map';

// Authoritative {fromType, toType} expectations for all 38 tools.
// Drives CONVERSION_FEATURES[`${fromType}/${toType}`] gating + buildRequest branching.
const EXPECTED: Record<string, { fromType: string; toType: string }> = {
  // pdf→X (convert-target, fromType='pdf')
  'pdf-to-word': { fromType: 'pdf', toType: 'docx' },
  'pdf-to-json': { fromType: 'pdf', toType: 'json' },
  'pdf-to-html': { fromType: 'pdf', toType: 'html' },
  'pdf-to-csv': { fromType: 'pdf', toType: 'csv' },
  'pdf-to-excel': { fromType: 'pdf', toType: 'xlsx' },
  'pdf-to-txt': { fromType: 'pdf', toType: 'txt' },
  'pdf-to-powerpoint': { fromType: 'pdf', toType: 'pptx' },
  'pdf-to-image': { fromType: 'pdf', toType: 'png' },
  'pdf-to-rtf': { fromType: 'pdf', toType: 'rtf' },
  // pdf→X (convert-type, fromType='pdf')
  'pdf-to-editable': { fromType: 'pdf', toType: 'searchablePdf' },
  'pdf-to-ofd': { fromType: 'pdf', toType: 'ofd' },
  // X→pdf (convert-to-pdf)
  'word-to-pdf': { fromType: 'docx', toType: 'pdf' },
  'rtf-to-pdf': { fromType: 'rtf', toType: 'pdf' },
  'excel-to-pdf': { fromType: 'xlsx', toType: 'pdf' },
  'txt-to-pdf': { fromType: 'txt', toType: 'pdf' },
  'csv-to-pdf': { fromType: 'csv', toType: 'pdf' },
  'powerpoint-to-pdf': { fromType: 'pptx', toType: 'pdf' },
  'html-to-pdf': { fromType: 'html', toType: 'pdf' },
  'png-to-pdf': { fromType: 'img', toType: 'pdf' },
  'image-to-pdf': { fromType: 'img', toType: 'pdf' },
  // img→X (convert-type, fromType='img')
  'image-to-word': { fromType: 'img', toType: 'docx' },
  'image-to-html': { fromType: 'img', toType: 'html' },
  'image-to-excel': { fromType: 'img', toType: 'xlsx' },
  'image-to-txt': { fromType: 'img', toType: 'txt' },
  'image-to-rtf': { fromType: 'img', toType: 'rtf' },
  'image-to-powerpoint': { fromType: 'img', toType: 'pptx' },
  'image-to-json': { fromType: 'img', toType: 'json' },
  'image-to-csv': { fromType: 'img', toType: 'csv' },
  // pdf edit ops (kind='pdf', fromType='pdf', toType = catalog toType NOT op)
  'merge': { fromType: 'pdf', toType: 'merge' },
  'split': { fromType: 'pdf', toType: 'split' },
  'insert': { fromType: 'pdf', toType: 'insert' },
  'delete': { fromType: 'pdf', toType: 'delete' },
  'rotate': { fromType: 'pdf', toType: 'rotate' },
  'compress': { fromType: 'pdf', toType: 'compress' },
  'add-watermark': { fromType: 'pdf', toType: 'addWatermark' },
  'remove-watermark': { fromType: 'pdf', toType: 'removeWatermark' },
  'encrypt': { fromType: 'pdf', toType: 'encrypt' },
  'decrypt': { fromType: 'pdf', toType: 'decrypt' },
};

describe('convert-map', () => {
  it('has exactly 38 tools across 5 sections', () => {
    const all = TOOL_SECTIONS.flatMap((s) => s.tools);
    expect(all.length).toBe(38);
    expect(TOOL_SECTIONS.length).toBe(5);
  });

  it('every slug is unique', () => {
    const slugs = TOOL_SECTIONS.flatMap((s) => s.tools.map((t) => t.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('pdf-to-word → convert-target docx', () => {
    const t = resolveTool('pdf-to-word')!;
    expect(t.endpoint).toEqual({ kind: 'convert-target', target: 'docx' });
    expect(t.accept).toBe('.pdf');
  });

  it('image-to-word → convert-type img/docx', () => {
    const t = resolveTool('image-to-word')!;
    expect(t.endpoint).toEqual({ kind: 'convert-type', type: 'img/docx' });
    expect(t.accept).toBe('.jpg,.png,.jpeg,.bmp');
  });

  it('pdf-to-editable → convert-type pdf/pdf', () => {
    expect(resolveTool('pdf-to-editable')!.endpoint).toEqual({ kind: 'convert-type', type: 'pdf/pdf' });
  });

  it('pdf-to-ofd → convert-type pdf/ofd', () => {
    expect(resolveTool('pdf-to-ofd')!.endpoint).toEqual({ kind: 'convert-type', type: 'pdf/ofd' });
  });

  it('image-to-json → convert-type img/json', () => {
    expect(resolveTool('image-to-json')!.endpoint).toEqual({ kind: 'convert-type', type: 'img/json' });
  });

  it('word-to-pdf → convert-to-pdf docx/pdf', () => {
    expect(resolveTool('word-to-pdf')!.endpoint).toEqual({ kind: 'convert-to-pdf', type: 'docx/pdf' });
  });

  it('image-to-pdf → convert-to-pdf png/pdf (no explicit type; auto-infer)', () => {
    const t = resolveTool('image-to-pdf')!;
    expect(t.endpoint.kind).toBe('convert-to-pdf');
    expect(t.accept).toBe('.jpg,.png,.jpeg,.bmp');
  });

  it('merge → pdf merge, multiple files', () => {
    const t = resolveTool('merge')!;
    expect(t.endpoint).toEqual({ kind: 'pdf', op: 'merge' });
    expect(t.multiple).toBe(true);
    expect(t.accept).toBe('.pdf');
  });

  it('add-watermark → pdf watermark/add', () => {
    expect(resolveTool('add-watermark')!.endpoint).toEqual({ kind: 'pdf', op: 'watermark/add' });
  });

  it('image-to-pdf is grouped under image-to-others (section 2), not others-to-pdf (section 1)', () => {
    const imgSection = TOOL_SECTIONS[2];
    const pdfSection = TOOL_SECTIONS[1];
    expect(imgSection.tools.map((t) => t.slug)).toContain('image-to-pdf');
    expect(pdfSection.tools.map((t) => t.slug)).not.toContain('image-to-pdf');
  });

  it('returns null for unknown slug', () => {
    expect(resolveTool('nope')).toBeNull();
  });

  it('every tool has a slug and icon', () => {
    for (const t of TOOL_SECTIONS.flatMap((s) => s.tools)) {
      expect(t.slug.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });

  describe('resolveConversionTypes', () => {
    it('the EXPECTED table covers exactly all 38 catalog tools', () => {
      const all = TOOL_SECTIONS.flatMap((s) => s.tools);
      expect(all.length).toBe(38);
      for (const t of all) {
        expect(EXPECTED[t.slug], `missing EXPECTED entry for ${t.slug}`).toBeDefined();
      }
      expect(Object.keys(EXPECTED).length).toBe(38);
    });

    it('returns the expected {fromType, toType} for every catalog tool', () => {
      const all = TOOL_SECTIONS.flatMap((s) => s.tools);
      expect(all.length).toBe(38);
      for (const t of all) {
        const got = resolveConversionTypes(t);
        const want = EXPECTED[t.slug];
        expect(got).toEqual(want);
      }
    });

    it('every resolved pair hits a CONVERSION_FEATURES entry (no dead branches)', async () => {
      const { CONVERSION_FEATURES } = await import('./param-schema');
      const all = TOOL_SECTIONS.flatMap((s) => s.tools);
      for (const t of all) {
        const { fromType, toType } = resolveConversionTypes(t);
        const key = `${fromType}/${toType}`;
        expect(CONVERSION_FEATURES[key], `${t.slug} → ${key} has no CONVERSION_FEATURES entry`).toBeDefined();
      }
    });
  });
});
