import { existsSync, createReadStream } from 'fs';
import { join } from 'path';
import axios from 'axios';
import FormData from 'form-data';

export type SmokeCase = {
  name: string;
  path: string;
  fields: Record<string, string>;
  files: Array<{ field: string; path: string }>;
};

type FixtureMap = {
  pdf: string;
  pdf2: string;
  docx: string;
  xlsx: string;
  pptx: string;
  png: string;
  txt: string;
  html: string;
  csv: string;
  rtf: string;
};

type Result = 'PASS' | 'SKIPPED_MISSING_FIXTURE' | 'FAIL';

const serverBaseUrl = process.env.MIDDLEWARE_BASE_URL ?? 'http://localhost:8080';
const fixturesDir = process.env.SDK_SMOKE_FIXTURES ?? join(__dirname, '..', 'test', 'fixtures');

const fixture = (name: string) => join(fixturesDir, name);

const fixtures: FixtureMap = {
  pdf: fixture('sample.pdf'),
  pdf2: fixture('sample-2.pdf'),
  docx: fixture('sample.docx'),
  xlsx: fixture('sample.xlsx'),
  pptx: fixture('sample.pptx'),
  png: fixture('sample.png'),
  txt: fixture('sample.txt'),
  html: fixture('sample.html'),
  csv: fixture('sample.csv'),
  rtf: fixture('sample.rtf'),
};

const file = (field: string, path: string) => ({ field, path });
const json = (value: Record<string, unknown>) => JSON.stringify(value);

const conversionCases: SmokeCase[] = [
  { name: 'pdf to word', path: '/api/v1/process/pdf/docx', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to excel', path: '/api/v1/process/pdf/xlsx', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to powerpoint', path: '/api/v1/process/pdf/pptx', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to html', path: '/api/v1/process/pdf/html', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to image', path: '/api/v1/process/pdf/png', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to txt', path: '/api/v1/process/pdf/txt', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to json', path: '/api/v1/process/pdf/json', fields: { options: json({ pageRanges: '1', isContainImg: '0' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to csv', path: '/api/v1/process/pdf/csv', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to rtf', path: '/api/v1/process/pdf/rtf', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to editable', path: '/api/v1/process/pdf/pdf', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf to ofd', path: '/api/v1/process/pdf/ofd', fields: { options: json({ pageRanges: '1' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'word to pdf', path: '/api/v1/process/docx/pdf', fields: {}, files: [file('file', fixtures.docx)] },
  { name: 'excel to pdf', path: '/api/v1/process/xlsx/pdf', fields: {}, files: [file('file', fixtures.xlsx)] },
  { name: 'powerpoint to pdf', path: '/api/v1/process/pptx/pdf', fields: {}, files: [file('file', fixtures.pptx)] },
  { name: 'png to pdf', path: '/api/v1/process/png/pdf', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'txt to pdf', path: '/api/v1/process/txt/pdf', fields: {}, files: [file('file', fixtures.txt)] },
  { name: 'html to pdf', path: '/api/v1/process/html/pdf', fields: {}, files: [file('file', fixtures.html)] },
  { name: 'csv to pdf', path: '/api/v1/process/csv/pdf', fields: {}, files: [file('file', fixtures.csv)] },
  { name: 'rtf to pdf', path: '/api/v1/process/rtf/pdf', fields: {}, files: [file('file', fixtures.rtf)] },
  { name: 'image to word', path: '/api/v1/process/img/docx', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'image to excel', path: '/api/v1/process/img/xlsx', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'image to powerpoint', path: '/api/v1/process/img/pptx', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'image to pdf', path: '/api/v1/process/png/pdf', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'image to txt', path: '/api/v1/process/img/txt', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'image to html', path: '/api/v1/process/img/html', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'image to rtf', path: '/api/v1/process/img/rtf', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'image to csv', path: '/api/v1/process/img/csv', fields: {}, files: [file('file', fixtures.png)] },
  { name: 'image to json', path: '/api/v1/process/img/json', fields: { options: json({ isContainImg: '0' }) }, files: [file('file', fixtures.png)] },
];

const pdfCases: SmokeCase[] = [
  { name: 'pdf merge', path: '/api/v1/pdf/merge', fields: { request: json({ pageRanges: ['all', 'all'] }) }, files: [file('files', fixtures.pdf), file('files', fixtures.pdf2)] },
  { name: 'pdf split', path: '/api/v1/pdf/split', fields: { request: json({ ranges: ['0-0'] }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf extract pages', path: '/api/v1/pdf/extract', fields: { request: json({ pages: [0] }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf insert from pdf', path: '/api/v1/pdf/insert-from-pdf', fields: { request: json({ pageIndex: 0, insertPageRanges: 'all' }) }, files: [file('file', fixtures.pdf), file('insertFile', fixtures.pdf2)] },
  { name: 'pdf insert blank page', path: '/api/v1/pdf/insert-blank', fields: { request: json({ pageIndex: 0, pageCount: 1 }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf delete pages', path: '/api/v1/pdf/delete', fields: { request: json({ pages: [0] }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf rotate pages', path: '/api/v1/pdf/rotate', fields: { request: json({ pages: [0], angle: 90 }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf compress', path: '/api/v1/pdf/compress', fields: { request: json({ quality: 'medium' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf add watermark', path: '/api/v1/pdf/watermark/add', fields: { request: json({ type: 'text', text: 'ComPDF', opacity: 0.3 }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf remove watermark', path: '/api/v1/pdf/watermark/remove', fields: { request: json({ indices: [0] }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf encrypt', path: '/api/v1/pdf/encrypt', fields: { request: json({ userPassword: '123456', ownerPassword: '123456' }) }, files: [file('file', fixtures.pdf)] },
  { name: 'pdf decrypt', path: '/api/v1/pdf/decrypt', fields: { request: json({ password: '123456' }) }, files: [file('file', fixtures.pdf)] },
];

export const smokeCases: SmokeCase[] = [...conversionCases, ...pdfCases];

async function runCase(c: SmokeCase): Promise<Result> {
  const missing = c.files.find((f) => !existsSync(f.path));
  if (missing) {
    console.log(`${c.name}: SKIPPED_MISSING_FIXTURE ${missing.path}`);
    return 'SKIPPED_MISSING_FIXTURE';
  }

  const form = new FormData();
  for (const [k, v] of Object.entries(c.fields)) form.append(k, v);
  for (const f of c.files) form.append(f.field, createReadStream(f.path));

  try {
    const res = await axios.post(`${serverBaseUrl}${c.path}`, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
      validateStatus: (s) => s >= 200 && s < 300,
      timeout: 300_000,
    });
    const bytes = Buffer.from(res.data).length;
    if (bytes === 0) throw new Error('empty response body');
    console.log(`${c.name}: PASS ${res.status} ${bytes} bytes`);
    return 'PASS';
  } catch (error) {
    const e = error as { message?: string; response?: { status?: number; data?: unknown } };
    console.log(`${c.name}: FAIL ${e.response?.status ?? ''} ${e.message ?? 'unknown error'}`);
    return 'FAIL';
  }
}

async function main() {
  console.log(`MIDDLEWARE_BASE_URL=${serverBaseUrl}`);
  console.log(`COMPDF_SDK_BASE_URL=${process.env.COMPDF_SDK_BASE_URL ?? '(middleware env, not read by this runner)'}`);
  const selected = process.env.SDK_SMOKE_CASES
    ? smokeCases.filter((c) => c.name.includes(process.env.SDK_SMOKE_CASES as string))
    : smokeCases;
  const results = await Promise.all(selected.map(runCase));
  const failed = results.filter((r) => r === 'FAIL').length;
  const skipped = results.filter((r) => r === 'SKIPPED_MISSING_FIXTURE').length;
  const passed = results.filter((r) => r === 'PASS').length;
  console.log(`summary: ${passed} passed, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  void main();
}
