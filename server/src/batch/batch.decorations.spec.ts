import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MysqlClient } from '../clients/mysql.client';
import { PdfSdkClient } from '../clients/pdf-sdk.client';
import { ConversionService } from '../conversion/conversion.service';
import { TaskService } from '../task/task.service';
import { BatchService } from './batch.service';

const operations = [
  ['headers-footers/add', 'addHeadersFooters', { regions: { bottomCenter: 'Page <<1>>' } }],
  ['headers-footers/remove', 'removeHeadersFooters', {}],
  ['bates/add', 'addBates', { position: 'bottomRight', startNumber: 1, digits: 6 }],
  ['bates/remove', 'removeBates', {}],
] as const;
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fixture(storageDir = 'unused-test-storage') {
  const mysql = { query: vi.fn().mockResolvedValue([]), execute: vi.fn().mockResolvedValue({ affectedRows: 1 }), transaction: vi.fn() };
  mysql.transaction.mockImplementation((work) => work(mysql));
  const sdk = Object.fromEntries(operations.map(([, method]) => [method, vi.fn().mockResolvedValue({
    buffer: Buffer.from('%PDF result'), headers: { 'content-type': 'application/pdf' },
  })]));
  const config = { get: (key: string) => key === 'storageDir' ? storageDir : key === 'jwt.secret' ? 'test-secret' : undefined } as ConfigService;
  const batch = new BatchService(mysql as unknown as MysqlClient, sdk as unknown as PdfSdkClient, {} as ConversionService, config);
  const task = new TaskService(mysql as unknown as MysqlClient, sdk as unknown as PdfSdkClient, {} as ConversionService, config);
  return { batch, task, mysql, sdk };
}

describe('batch and single-file task decoration dispatch', () => {
  it.each(operations)('dispatches %s in both pipelines', async (op, method, params) => {
    const { batch, task, sdk } = fixture();
    const file = { originalname: 'source.pdf', buffer: Buffer.from('%PDF source') } as Express.Multer.File;
    const request = { ...params, password: 'file-password' };
    await (batch as any).dispatch({ kind: 'pdf', op }, file, request, {}, 'file-password');
    await (task as any).dispatch({ kind: 'pdf', op, request: JSON.stringify(request) }, [file]);
    expect(sdk[method]).toHaveBeenCalledTimes(2);
    expect(sdk[method]).toHaveBeenNthCalledWith(1, file, request, '');
    expect(sdk[method]).toHaveBeenNthCalledWith(2, file, request, '');
  });

  it.each([undefined, 'continuous', 'unknown'])('does not silently create non-per-file Bates batches: %s', async (numberingMode) => {
    const { batch, mysql } = fixture();
    await expect(batch.create({ kind: 'pdf', op: 'bates/add', request: operations[2][2], options: { numberingMode } }, 'key-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mysql.execute).not.toHaveBeenCalled();
  });

  it('freezes explicit per-file Bates parameters in the batch record', async () => {
    const { batch, mysql } = fixture();
    vi.spyOn(batch, 'getRequired').mockResolvedValue({ batchId: 'batch-1' } as any);
    await batch.create({ kind: 'pdf', op: 'bates/add', request: operations[2][2], options: { numberingMode: 'per-file' } }, 'key-1');
    expect(mysql.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO batches'), expect.arrayContaining([
      'key-1', 'bates/add', JSON.stringify(operations[2][2]), '{"numberingMode":"per-file"}',
    ]));
  });

  it('rejects batch-level passwords and invalid header/footer settings before persistence', async () => {
    const { batch, mysql } = fixture();
    await expect(batch.create({ kind: 'pdf', op: 'headers-footers/add', request: { ...operations[0][2], password: 'secret' } }, 'key-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(batch.create({ kind: 'pdf', op: 'headers-footers/add', request: { regions: {} } }, 'key-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mysql.execute).not.toHaveBeenCalled();
  });

  it('uses the password bound to the item and saves the requested output name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'compdf-decoration-test-'));
    directories.push(dir);
    const { batch, mysql, sdk } = fixture(dir);
    const source = join(dir, 'source.pdf');
    await writeFile(source, '%PDF source');
    mysql.query.mockResolvedValue([{ kind: 'pdf', op: 'bates/add', request_json: { ...operations[2][2], outputFileName: 'case.pdf' }, options_json: { numberingMode: 'per-file' } }]);
    vi.spyOn(batch as any, 'refreshBatch').mockResolvedValue(undefined);
    await batch.process({ item_id: 'item-1', batch_id: 'batch-1', source_path: source, source_name: 'source.pdf',
      source_password_ciphertext: (batch as any).encrypt('file-password'), lease_owner: 'lease-1', status: 'processing', sequence_no: 1, source_size: 11, attempt_count: 1 });
    expect(sdk.addBates).toHaveBeenCalledWith(expect.objectContaining({ originalname: 'source.pdf' }), expect.objectContaining({ password: 'file-password', startNumber: 1, digits: 6 }), '');
    expect(await readFile(join(dir, 'batches', 'batch-1', 'outputs', 'item-1', 'lease-1', 'result.bin'), 'utf8')).toBe('%PDF result');
    expect(mysql.execute).toHaveBeenCalledWith(expect.stringContaining("SET status = 'success', output_path"), expect.arrayContaining(['case.pdf', 'item-1', 'lease-1']));
  });
});
