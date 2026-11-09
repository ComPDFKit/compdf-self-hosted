import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { nameSplitOutputs } from './result-archive';

/** Valid PDFs with page labels; padding sends larger groups through async inflate. */
function pdfPages(pages: number[], padding = 0): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, page] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    const stream = `BT /F1 24 Tf 72 720 Td (Page ${page}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  if (padding) pdf += `%${'x'.repeat(padding)}\n`;
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function renamedFiles(files: Record<string, Uint8Array>, separator = '_', source = 'report.pdf') {
  const input = new Blob([new Uint8Array(zipSync(files))], { type: 'application/zip' });
  const output = await nameSplitOutputs(input, source, separator);
  expect(output.type).toBe('application/zip');
  return unzipSync(new Uint8Array(await output.arrayBuffer()));
}

describe('split output numbering', () => {
  it.each(['_', '-', '.', ' '])('preserves custom range order with separator %j when later groups inflate first', async (separator) => {
    const groups = [[1, 2, 3], [4, 5, 6], [8, 10]];
    const pdfs = groups.map((pages, index) => pdfPages(pages, index < 2 ? 600_000 : 0));
    const files = await renamedFiles({
      'part-1.pdf': pdfs[0]!, 'part-2.pdf': pdfs[1]!, 'part-3.pdf': pdfs[2]!,
    }, separator);
    expect(Object.keys(files)).toEqual(groups.map((_, index) => `report${separator}${index + 1}.pdf`));
    groups.forEach((pages, index) => {
      const bytes = files[`report${separator}${index + 1}.pdf`]!;
      // Renaming must not alter PDF bytes, page counts, or the selected pages.
      expect(Buffer.from(bytes).equals(Buffer.from(pdfs[index]!))).toBe(true);
      const text = new TextDecoder().decode(bytes);
      expect([...text.matchAll(/\/Type \/Page\b/g)]).toHaveLength(pages.length);
      expect([...text.matchAll(/\(Page (\d+)\)/g)].map((match) => Number(match[1]))).toEqual(pages);
    });
  });

  it('uses archive order rather than alphabetical or page-number order', async () => {
    const first = pdfPages([8, 10]);
    const second = pdfPages([1, 2, 3]);
    const files = await renamedFiles({ 'z.pdf': first, 'a.pdf': second });
    expect(Object.keys(files)).toEqual(['report_1.pdf', 'report_2.pdf']);
    expect(files['report_1.pdf']).toEqual(first);
    expect(files['report_2.pdf']).toEqual(second);
  });

  it('ignores directory entries and excludes non-PDF files from the numbering', async () => {
    const first = pdfPages([1, 2, 3]);
    const second = pdfPages([4, 5, 6]);
    const note = new TextEncoder().encode('Split output');
    const files = await renamedFiles({
      'output/': new Uint8Array(), 'output/first.PDF': first,
      'output/readme.txt': note, 'output/second.pdf': second,
    }, '_', '中文报告.PDF');
    expect(Object.keys(files)).toEqual(['中文报告_1.pdf', 'readme.txt', '中文报告_2.pdf']);
    expect(files['中文报告_1.pdf']).toEqual(first);
    expect(files['中文报告_2.pdf']).toEqual(second);
    expect(files['readme.txt']).toEqual(note);
  });

  it('rejects invalid archives instead of returning a partial result', async () => {
    await expect(nameSplitOutputs(new Blob(['invalid ZIP']), 'report.pdf', '_')).rejects.toThrow();
  });
});
