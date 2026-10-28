import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchService } from './batch.service';
import { BatchWorker } from './batch.worker';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

function fixture(storageDir = 'unused') {
  const mysql = { query: vi.fn().mockResolvedValue([]), execute: vi.fn().mockResolvedValue({ affectedRows: 1 }), transaction: vi.fn() };
  mysql.transaction.mockImplementation((work) => work(mysql));
  const sdk = { encrypt: vi.fn().mockResolvedValue({ buffer: Buffer.from('%PDF result'), headers: { 'content-type': 'application/pdf' } }) };
  const service = new BatchService(mysql as any, sdk as any, {} as any, { get: (key: string) => key === 'storageDir' ? storageDir : key === 'jwt.secret' ? 'test-only-key' : undefined } as ConfigService);
  return { mysql, sdk, service };
}

describe('batch encryption and lease regressions', () => {
  it('allows encrypt output passwords, stores them encrypted and does not mutate the request', async () => {
    const { mysql, service } = fixture();
    vi.spyOn(service, 'getRequired').mockResolvedValue({ batchId: 'batch' } as any);
    const request = { userPassword: 'output-user', ownerPassword: 'output-owner', algorithm: 'AES256' };
    await service.create({ kind: 'pdf', op: 'encrypt', request }, 'key');
    const values = mysql.execute.mock.calls[0][1];
    expect(JSON.parse(values[7])).toEqual({ algorithm: 'AES256' });
    expect(values[9]).not.toContain('output-user');
    expect(JSON.parse((service as any).decrypt(values[9]))).toEqual({ userPassword: 'output-user', ownerPassword: 'output-owner' });
    expect(request.userPassword).toBe('output-user');
  });

  it.each([
    { op: 'encrypt', request: { userPassword: '' } },
    { op: 'encrypt', request: { userPassword: 'valid', ownerPassword: 123 } },
    { op: 'encrypt', request: { userPassword: 'valid', password: 'source' } },
    { op: 'decrypt', request: { userPassword: 'invalid-public-password' } },
  ])('rejects invalid/common source password settings before insert: $op', async ({ op, request }) => {
    const { mysql, service } = fixture();
    await expect(service.create({ kind: 'pdf', op, request }, 'key')).rejects.toBeInstanceOf(BadRequestException);
    expect(mysql.execute).not.toHaveBeenCalled();
  });

  it('restores output passwords independently of the source password and fences stale lease writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'compdf-batch-regression-'));
    directories.push(dir);
    const { mysql, sdk, service } = fixture(dir);
    const source = join(dir, 'source.pdf');
    await writeFile(source, '%PDF source');
    mysql.query.mockResolvedValue([{ kind: 'pdf', op: 'encrypt', request_json: {}, output_passwords_ciphertext: (service as any).encrypt(JSON.stringify({ userPassword: 'new-user', ownerPassword: 'new-owner' })) }]);
    mysql.execute.mockResolvedValue({ affectedRows: 0 });
    const item = { item_id: 'item', batch_id: 'batch', source_path: source, source_name: 'source.pdf', source_password_ciphertext: (service as any).encrypt('old-open'), status: 'processing', lease_owner: 'expired-lease', attempt_count: 1, sequence_no: 1, source_size: 11 };
    await service.process(item as any);
    expect(sdk.encrypt).toHaveBeenCalledWith(expect.anything(), { userPassword: 'new-user', ownerPassword: 'new-owner', password: 'old-open' }, '');
    expect(mysql.execute.mock.calls.some(([sql]) => /DELETE FROM batch_item_outputs|INSERT INTO batch_item_outputs|UPDATE batch_attempts/.test(sql))).toBe(false);
    await expect(readFile(join(dir, 'batches', 'batch', 'outputs', 'item', 'expired-lease', 'result.bin'))).rejects.toThrow();
  });

  it('serializes overlapping worker polls while a claim is pending', async () => {
    let release!: (item: null) => void;
    const batches = { claimNext: vi.fn().mockImplementation(() => new Promise((resolve) => { release = resolve; })) };
    const worker = new BatchWorker(batches as any);
    const first = (worker as any).poll();
    await (worker as any).poll();
    expect(batches.claimNext).toHaveBeenCalledOnce();
    release(null);
    await first;
    expect((worker as any).polling).toBe(false);
  });
});
