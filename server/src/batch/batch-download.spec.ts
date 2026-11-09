import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { BatchService } from './batch.service';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

const cases = [
  ['conversion', 'convert', 'png', null, 'application/zip', 'report.zip'],
  ['conversion', 'convert', 'html', null, 'application/zip', 'report.zip'],
  ['conversion', 'convert', null, 'img/html', 'application/zip', 'report.zip'],
  ['conversion', 'convert', 'png', null, 'image/jpeg', 'report.jpg'],
  ['conversion', 'convert', 'docx', null, 'application/octet-stream', 'report.docx'],
  ['conversion', 'convert', null, 'pdf/markdown', 'text/markdown', 'report.md'],
  ['conversion', 'convert-to-pdf', null, 'docx/pdf', 'application/pdf', 'report.pdf'],
  ['pdf', 'split', null, null, 'application/zip', 'report.zip'],
  ['pdf', 'rotate', null, null, 'application/pdf', 'report.pdf'],
] as const;

describe('batch output filenames without upstream names', () => {
  it.each(cases)('%s %s %s %s keeps %s as %s', async (kind, op, target, type, contentType, expected) => {
    const directory = await mkdtemp(join(tmpdir(), 'compdf-batch-download-'));
    directories.push(directory);
    const source = join(directory, 'source');
    await writeFile(source, '%PDF source');
    const mysql = { query: vi.fn(), execute: vi.fn().mockResolvedValue({ affectedRows: 1 }), transaction: vi.fn() };
    mysql.transaction.mockImplementation((work) => work(mysql));
    mysql.query.mockResolvedValue([{ kind, op, target, type, request_json: {}, options_json: {} }]);
    const service = new BatchService(mysql as any, {} as any, {} as any, { get: (key: string) => key === 'storageDir' ? directory : undefined } as ConfigService);
    const bytes = Buffer.from(zipSync({ 'page.pdf': new Uint8Array([1, 2, 3]) }));
    // Office documents are ZIP containers too; their MIME and target must keep .docx.
    vi.spyOn(service as any, 'dispatch').mockResolvedValue(kind === 'pdf'
      ? { buffer: bytes, headers: { 'content-type': contentType } }
      : { buffer: bytes, contentType, truncated: false });
    vi.spyOn(service as any, 'refreshBatch').mockResolvedValue(undefined);
    await service.process({ item_id: 'item', batch_id: 'batch', source_path: source, source_name: 'report.pdf',
      source_password_ciphertext: null, lease_owner: 'lease', status: 'processing', sequence_no: 1, source_size: 11, attempt_count: 1 } as any);
    const save = mysql.execute.mock.calls.find(([sql]) => sql.includes("SET status = 'success', output_path"));
    expect(save?.[1][1]).toBe(expected);
    expect(save?.[1][2]).toBe(contentType);
    expect(await readFile(save![1][0])).toEqual(bytes);
  });
});
