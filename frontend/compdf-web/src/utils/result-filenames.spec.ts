import { describe, expect, it } from 'vitest';
import { TOOL_SECTIONS, type Endpoint } from '@/config/convert-map';
import { availableArchivePath, defaultResultFilename } from './result-filenames';

const tools = TOOL_SECTIONS.flatMap((section) => section.tools);

describe('result filenames for every tool', () => {
  it.each(tools)('$slug uses its output format when headers and metadata are absent', ({ endpoint }) => {
    const extension = endpoint.kind === 'convert-target' ? endpoint.target
      : endpoint.kind === 'convert-type' ? endpoint.type.split('/')[1]!
      : endpoint.kind === 'pdf' && endpoint.op === 'split' ? 'zip' : 'pdf';
    const expected = endpoint.kind === 'pdf' && endpoint.op === 'merge' ? 'merged.pdf'
      : `中文报告.${extension === 'markdown' ? 'md' : extension}`;
    expect(defaultResultFilename(endpoint, '中文报告.source', '')).toBe(expected);
  });

  it.each(['application/zip', 'application/x-zip-compressed', 'APPLICATION/ZIP; charset=binary'])(
    'keeps archives as ZIPs for %s', (mime) => {
      expect(defaultResultFilename({ kind: 'convert-target', target: 'png' }, 'report.pdf', mime)).toBe('report.zip');
    },
  );

  it('uses the actual selected image format', () => {
    expect(defaultResultFilename({ kind: 'convert-target', target: 'png' }, 'report.pdf', 'image/jpeg')).toBe('report.jpg');
  });

  it.each([
    [{ kind: 'pdf', op: 'merge' }, { outputFileName: ' 自定义.pdf ' }, '自定义.pdf'],
    [{ kind: 'pdf', op: 'split' }, { zipFileName: ' 拆分结果.zip ' }, '拆分结果.zip'],
  ] as const)('preserves a requested name for %o', (endpoint, request, expected) => {
    expect(defaultResultFilename(endpoint as Endpoint, 'source.pdf', '', request)).toBe(expected);
  });

  it.each([
    ['headers-footers/add', 'header-footer-added.pdf'],
    ['headers-footers/remove', 'header-footer-removed.pdf'],
    ['watermark/add', 'watermarked.pdf'],
    ['delete', '956-deleted-pages.pdf'],
    ['encrypt', 'encrypted.pdf'],
  ])('keeps the uploaded name for %s despite the server name', (op, reported) => {
    expect(defaultResultFilename({ kind: 'pdf', op } as Endpoint, '956.pdf', 'application/pdf', undefined, reported)).toBe('956.pdf');
  });

  it.each([
    ['application/octet-stream', 'images.zip', '报告.v2.zip'],
    ['', 'converted.jpeg', '报告.v2.jpeg'],
    ['application/zip', 'converted.png', '报告.v2.zip'],
    ['image/jpeg', 'converted.zip', '报告.v2.jpg'],
  ])('uses the actual format without borrowing the server basename (%s, %s)', (mime, reported, expected) => {
    expect(defaultResultFilename({ kind: 'convert-target', target: 'png' }, '报告.v2.pdf', mime, undefined, reported)).toBe(expected);
  });

  it('retains a custom basename while correcting its extension to the actual archive format', () => {
    expect(defaultResultFilename({ kind: 'convert-target', target: 'png' }, 'source.pdf', 'application/zip', { outputFileName: '自定义.png' }, 'images.zip')).toBe('自定义.zip');
  });

  it('adds extensions to source files without one', () => {
    expect(defaultResultFilename({ kind: 'convert-to-pdf' }, 'README', '')).toBe('README.pdf');
  });
});

describe('archive filename collisions', () => {
  it('never overwrites existing names, including names that look generated', () => {
    const files: Record<string, Uint8Array> = Object.create(null);
    const names = ['3-report.pdf', 'report.pdf', 'report.pdf', 'report (2).pdf', 'report.pdf'];
    const paths = names.map((name, index) => {
      const path = availableArchivePath(`source-${index}.pdf`, name, files);
      files[path] = new Uint8Array([index]);
      return path;
    });
    expect(new Set(paths).size).toBe(names.length);
    expect(Object.values(files).map((bytes) => bytes[0])).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps different source directories separate and suffixes within each folder', () => {
    const files = { 'case/a/report.pdf': new Uint8Array(), 'case/a/report (2).pdf': new Uint8Array() };
    expect(availableArchivePath('case/a/source.pdf', 'report.pdf', files)).toBe('case/a/report (3).pdf');
    expect(availableArchivePath('case/b/source.pdf', 'report.pdf', files)).toBe('case/b/report.pdf');
    expect(availableArchivePath('case\\a\\source.pdf', 'report.pdf', files)).toBe('case/a/report (3).pdf');
  });

  it('keeps header paths from escaping the source folder', () => {
    expect(availableArchivePath('case/../nested/source.pdf', '../../report.pdf', {})).toBe('case/nested/report.pdf');
  });
});
