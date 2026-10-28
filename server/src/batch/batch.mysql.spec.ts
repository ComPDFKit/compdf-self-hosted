import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createPool, Pool } from 'mysql2/promise';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MysqlClient, MysqlTransaction } from '../clients/mysql.client';
import { initializeSchema } from '../scripts/init-db';
import { applyMigrations, currentSchemaVersion, discoverMigrationPath, discoverMigrations, verifyAppliedMigrationChecksums } from '../scripts/migrate-db';
import { BatchService } from './batch.service';

// Opt-in only: dedicated localhost MySQL. Each test owns a randomly named database.
const port = Number(process.env.BATCH_MYSQL_TEST_PORT);
const migrations = resolve(__dirname, '../../..', 'migrations');
const steps = discoverMigrationPath(migrations, '1.0.0', '1.1.0');
describe.skipIf(!port)('batch lifecycle on real MySQL', () => {
  let admin: Pool;
  let pool: Pool;
  let client: MysqlClient;
  let database: string;
  let storage: string;
  let service: BatchService;
  let sdk: { rotate: ReturnType<typeof vi.fn> };
  const connection = { host: '127.0.0.1', port, user: 'root', password: process.env.BATCH_MYSQL_TEST_PASSWORD ?? '' };
  const file = { originalname: 'source.pdf', buffer: Buffer.from('%PDF-1.7 source'), mimetype: 'application/pdf' } as Express.Multer.File;

  function makeService(limits: Record<string, number> = {}, db = client) {
    return new BatchService(db, sdk as any, {} as any, { get: (key: string) => ({ storageDir: storage, 'jwt.secret': 'batch-test-only-secret', ...limits } as Record<string, unknown>)[key] } as ConfigService);
  }
  async function prepare(count = 1) {
    const batch = await service.create({ kind: 'pdf', op: 'rotate', request: { angle: 90 } }, 'test-key');
    for (let i = 0; i < count; i++) await service.upload(batch.batchId, file, undefined, undefined, 'test-key');
    await service.commit(batch.batchId, 'test-key');
    return batch.batchId;
  }
  async function claimed() {
    const item = await service.claimNext(randomUUID());
    expect(item).not.toBeNull();
    return item!;
  }
  async function schemaUpgrade() {
    const db = await pool.getConnection();
    try { await applyMigrations(db as any, steps); } finally { db.release(); }
  }
  beforeAll(async () => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid dedicated MySQL test port');
    admin = createPool({ ...connection, connectionLimit: 1 });
    await admin.query('SELECT 1');
  }, 15000);
  beforeEach(async () => {
    database = `compdf_batch_test_${randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = createPool({ ...connection, database, multipleStatements: true, connectionLimit: 10 });
    await pool.query("CREATE TABLE schema_migrations (version VARCHAR(32) PRIMARY KEY, checksum VARCHAR(128) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations VALUES ('1.0.0', 'baseline:1.0.0', CURRENT_TIMESTAMP); CREATE TABLE api_keys (id BIGINT PRIMARY KEY)");
    await schemaUpgrade();
    storage = await mkdtemp(join(tmpdir(), 'compdf-batch-db-test-'));
    client = new MysqlClient({ get: (key: string) => ({ 'database.host': connection.host, 'database.port': port, 'database.user': connection.user, 'database.password': connection.password, 'database.name': database } as Record<string, unknown>)[key] } as ConfigService);
    sdk = { rotate: vi.fn().mockResolvedValue({ buffer: Buffer.from('%PDF result'), headers: { 'content-type': 'application/pdf' } }) };
    service = makeService();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await client?.onModuleDestroy();
    await pool?.end();
    if (/^compdf_batch_test_[a-f0-9]{32}$/.test(database)) await admin.query(`DROP DATABASE \`${database}\``);
    if (storage) await rm(storage, { recursive: true, force: true });
  });
  afterAll(async () => { await admin?.end(); });

  it('upgrades 1.0.0 to 1.1.0 and records the published migration checksum', async () => {
    expect(steps.map((step) => step.to)).toEqual(['1.1.0']);
    expect(steps[0].checksum).toBe('4b50dc79d035f16dff8ea5a92847c62c06cb329479fa4ad21599761aeaa61468');
    expect(await currentSchemaVersion(pool as any)).toBe('1.1.0');
    await verifyAppliedMigrationChecksums(pool as any, discoverMigrations(migrations));
  });

  it('upgrades an already applied 1.0.0 database, preserving legacy results, and replays interrupted DDL', async () => {
    const batchId = await prepare();
    const item = await claimed();
    await service.process(item);
    await pool.query("DROP TABLE batch_attempts; DROP TABLE batch_item_outputs; ALTER TABLE batch_items DROP COLUMN relative_path; ALTER TABLE batches DROP COLUMN output_passwords_ciphertext; DELETE FROM schema_migrations WHERE version = '1.1.0'");
    const incremental = discoverMigrationPath(migrations, '1.0.0', '1.1.0');
    expect(incremental).toHaveLength(1);
    // Simulate a crash after the first column was added but before recording 1.1.0.
    const db = await pool.getConnection();
    try {
      await db.query(incremental[0].sql.split('DEALLOCATE PREPARE compdf_batch_stmt;')[0] + 'DEALLOCATE PREPARE compdf_batch_stmt;');
      await applyMigrations(db as any, incremental);
      await db.query(incremental[0].sql);
      await applyMigrations(db as any, incremental);
      await verifyAppliedMigrationChecksums(db as any, discoverMigrations(migrations));
    } finally { db.release(); }
    const info = await service.getRequired(batchId, 'test-key');
    expect(info.status).toBe('success');
    expect(info.items[0].outputName).toBe('source.pdf');
    const archive = await service.batchDownload(batchId, 'test-key');
    expect(Object.values(unzipSync(archive!.buffer)).map((bytes) => Buffer.from(bytes).toString())).toEqual(['%PDF result']);
  });

  it('supports a fresh 1.1.0 baseline without confusing it with an applied migration', async () => {
    await pool.query('DROP TABLE batch_attempts; DROP TABLE batch_item_outputs; DROP TABLE batch_items; DROP TABLE batches; DROP TABLE schema_migrations; DROP TABLE api_keys');
    const sql = await readFile(resolve(migrations, '../configs/init.sql'), 'utf8');
    expect(await initializeSchema(pool as any, sql, '1.1.0')).toBe('initialized');
    expect(await initializeSchema(pool as any, sql, '1.1.0')).toBe('verified');
    await verifyAppliedMigrationChecksums(pool as any, discoverMigrations(migrations));
  });

  it('persists output encryption passwords separately and restores both password roles for the SDK', async () => {
    const encrypt = vi.fn().mockResolvedValue({ buffer: Buffer.from('%PDF encrypted result'), headers: { 'content-type': 'application/pdf' } });
    (sdk as any).encrypt = encrypt;
    const batch = await service.create({ kind: 'pdf', op: 'encrypt', request: { userPassword: 'output-user', ownerPassword: 'output-owner' } }, 'test-key');
    await service.upload(batch.batchId, file, 'source-open', undefined, 'test-key');
    const [rows] = await pool.query<any[]>('SELECT request_json, output_passwords_ciphertext FROM batches WHERE batch_id = ?', [batch.batchId]);
    expect(rows[0].request_json).toEqual({});
    expect(rows[0].output_passwords_ciphertext).not.toContain('output-user');
    await service.commit(batch.batchId, 'test-key');
    await service.process(await claimed());
    expect(encrypt).toHaveBeenCalledWith(expect.anything(), { userPassword: 'output-user', ownerPassword: 'output-owner', password: 'source-open' }, '');
    expect((await service.getRequired(batch.batchId, 'test-key')).status).toBe('success');
  });

  it('serializes 20 concurrent uploads without sequence collisions or count overflow', async () => {
    service = makeService({ 'batch.maxFiles': 7 });
    const batch = await service.create({ kind: 'pdf', op: 'rotate' }, 'test-key');
    const uploads = await Promise.allSettled(Array.from({ length: 20 }, () => service.upload(batch.batchId, file, undefined, undefined, 'test-key')));
    expect(uploads.filter((result) => result.status === 'fulfilled')).toHaveLength(7);
    const info = await service.getRequired(batch.batchId, 'test-key');
    expect(info.totalCount).toBe(7);
    expect(info.items.map((item) => item.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('does not exceed the total size limit under concurrent uploads', async () => {
    service = makeService({ 'batch.maxTotalBytes': file.buffer.length * 3 });
    const batch = await service.create({ kind: 'pdf', op: 'rotate' }, 'test-key');
    const uploads = await Promise.allSettled(Array.from({ length: 12 }, () => service.upload(batch.batchId, file, undefined, undefined, 'test-key')));
    expect(uploads.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect((await service.getRequired(batch.batchId, 'test-key')).totalCount).toBe(3);
  });

  it('serializes commit against uploads so no item remains uploaded in a committed batch', async () => {
    const batch = await service.create({ kind: 'pdf', op: 'rotate' }, 'test-key');
    await service.upload(batch.batchId, file, undefined, undefined, 'test-key');
    const uploads = Array.from({ length: 10 }, () => service.upload(batch.batchId, file, undefined, undefined, 'test-key'));
    await Promise.allSettled([...uploads, service.commit(batch.batchId, 'test-key')]);
    const info = await service.getRequired(batch.batchId, 'test-key');
    expect(info.status).toBe('queued');
    expect(info.items.every((item) => item.status === 'queued')).toBe(true);
    expect(info.queuedCount).toBe(info.totalCount);
    await expect(service.upload(batch.batchId, file, undefined, undefined, 'test-key')).rejects.toThrow('batch is no longer accepting files');
  });

  it('keeps a committed upload source if its commit acknowledgement is lost', async () => {
    const batch = await service.create({ kind: 'pdf', op: 'rotate' }, 'test-key');
    const transaction = client.transaction.bind(client);
    let loseAcknowledgement = true;
    vi.spyOn(client, 'transaction').mockImplementation(async (work) => {
      const result = await transaction(work);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('upload commit acknowledgement lost'); }
      return result;
    });
    await expect(service.upload(batch.batchId, file, undefined, undefined, 'test-key')).rejects.toThrow('upload commit acknowledgement lost');
    const info = await service.getRequired(batch.batchId, 'test-key');
    expect(info.totalCount).toBe(1);
    const [rows] = await pool.query<any[]>('SELECT source_path FROM batch_items WHERE item_id = ?', [info.items[0].itemId]);
    expect(await readFile(rows[0].source_path)).toEqual(file.buffer);
  });

  it('allows only one concurrent retry and generates a new ZIP after the retry succeeds', async () => {
    const batchId = await prepare(2);
    await service.process(await claimed());
    sdk.rotate.mockRejectedValueOnce(new Error('first attempt failed'));
    const failed = await claimed();
    await service.process(failed);
    expect((await service.getRequired(batchId, 'test-key')).status).toBe('partial_success');
    const before = (await service.batchDownload(batchId, 'test-key'))!;
    expect(Object.keys(unzipSync(before.buffer))).toHaveLength(1);
    const retries = await Promise.allSettled([service.retry(failed.item_id, undefined, 'test-key'), service.retry(failed.item_id, undefined, 'test-key')]);
    expect(retries.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await service.batchDownload(batchId, 'test-key')).toBeNull();
    sdk.rotate.mockResolvedValueOnce({ buffer: Buffer.from('%PDF retried result'), headers: { 'content-type': 'application/pdf' } });
    await service.process(await claimed());
    const after = (await service.batchDownload(batchId, 'test-key'))!;
    const values = Object.values(unzipSync(after.buffer)).map((bytes) => Buffer.from(bytes).toString());
    expect(values).toHaveLength(2);
    expect(values).toContain('%PDF retried result');
    expect(after.buffer.equals(before.buffer)).toBe(false);
  });

  it('cannot publish a ZIP snapshot if a retry changes results while it is built', async () => {
    const batchId = await prepare(2);
    await service.process(await claimed());
    sdk.rotate.mockRejectedValueOnce(new Error('fail'));
    const failed = await claimed();
    await service.process(failed);
    const create = (service as any).createArchive.bind(service);
    vi.spyOn(service as any, 'createArchive').mockImplementation(async (...args: unknown[]) => {
      await service.retry(failed.item_id, undefined, 'test-key');
      await create(...args);
    });
    await expect(service.batchDownload(batchId, 'test-key')).rejects.toThrow('batch results changed');
    const [rows] = await pool.query<any[]>('SELECT archive_path FROM batches WHERE batch_id = ?', [batchId]);
    expect(rows[0].archive_path).toBeNull();
  });

  it('rolls back success and output rows together when manifest insertion fails', async () => {
    const batchId = await prepare();
    const item = await claimed();
    const transaction = client.transaction.bind(client);
    vi.spyOn(client, 'transaction').mockImplementation((work) => transaction((db) => work({
      query: db.query,
      execute: (sql, params) => sql.startsWith('INSERT INTO batch_item_outputs') ? Promise.reject(new Error('injected manifest failure')) : db.execute(sql, params),
    })));
    await service.process(item);
    const info = await service.getRequired(batchId, 'test-key');
    expect(info.status).toBe('failed');
    expect(info.items[0].status).toBe('failed');
    expect(info.items[0].outputName).toBeUndefined();
    expect(info.items[0].outputs).toBeUndefined();
    const [attempts] = await pool.query<any[]>('SELECT status FROM batch_attempts WHERE item_id = ?', [item.item_id]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed']);
  });

  it('rolls back a claim if attempt insertion fails', async () => {
    const batchId = await prepare();
    const transaction = client.transaction.bind(client);
    vi.spyOn(client, 'transaction').mockImplementation((work) => transaction((db) => work({
      query: db.query,
      execute: (sql, params) => sql.startsWith('INSERT INTO batch_attempts') ? Promise.reject(new Error('injected attempt failure')) : db.execute(sql, params),
    })));
    await expect(service.claimNext(randomUUID())).rejects.toThrow('injected attempt failure');
    const info = await service.getRequired(batchId, 'test-key');
    expect(info.status).toBe('queued');
    expect(info.items[0].attemptCount).toBe(0);
    expect(info.items[0].status).toBe('queued');
  });

  it('rolls back the entire multi-output manifest when the second insert fails', async () => {
    (sdk as any).split = vi.fn().mockResolvedValue({ buffer: Buffer.from(zipSync({ 'first.pdf': Buffer.from('%PDF first'), 'second.pdf': Buffer.from('%PDF second') })), headers: { 'content-type': 'application/zip' } });
    const batch = await service.create({ kind: 'pdf', op: 'split' }, 'test-key');
    await service.upload(batch.batchId, file, undefined, undefined, 'test-key');
    await service.commit(batch.batchId, 'test-key');
    const transaction = client.transaction.bind(client);
    let insertions = 0;
    vi.spyOn(client, 'transaction').mockImplementation((work) => transaction((db) => work({
      query: db.query,
      execute: (sql, params) => {
        if (sql.startsWith('INSERT INTO batch_item_outputs') && ++insertions === 2) return Promise.reject(new Error('second output failed'));
        return db.execute(sql, params);
      },
    })));
    await service.process(await claimed());
    const info = await service.getRequired(batch.batchId, 'test-key');
    expect(info.status).toBe('failed');
    expect(info.items[0].outputs).toBeUndefined();
    const [rows] = await pool.query<any[]>('SELECT COUNT(*) AS count FROM batch_item_outputs');
    expect(rows[0].count).toBe(0);
  });

  it('keeps referenced output files when the commit succeeded but its acknowledgement was lost', async () => {
    const batchId = await prepare();
    const item = await claimed();
    const transaction = client.transaction.bind(client);
    let loseAcknowledgement = true;
    vi.spyOn(client, 'transaction').mockImplementation(async (work) => {
      const result = await transaction(work);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('commit acknowledgement lost'); }
      return result;
    });
    await service.process(item);
    expect((await service.getRequired(batchId, 'test-key')).status).toBe('success');
    expect((await service.itemDownload(item.item_id, 'test-key'))!.buffer.toString()).toBe('%PDF result');
  });

  it('claims concurrently without creating duplicate attempts for the same item', async () => {
    const batchId = await prepare(5);
    const claims = await Promise.all(Array.from({ length: 15 }, () => service.claimNext(randomUUID())));
    const claimedItems = claims.filter((item) => item !== null);
    expect(claimedItems.length).toBeGreaterThan(0);
    expect(new Set(claimedItems.map((item) => item!.item_id)).size).toBe(claimedItems.length);
    const [attempts] = await pool.query<any[]>('SELECT item_id, COUNT(*) AS count FROM batch_attempts GROUP BY item_id');
    expect(attempts.every((attempt) => attempt.count === 1)).toBe(true);
    const info = await service.getRequired(batchId, 'test-key');
    expect(info.processingCount).toBe(claimedItems.length);
    expect(info.queuedCount + info.processingCount).toBe(5);
  });

  it('keeps canceled in-flight work recoverable after lease expiry without starting canceled queued items', async () => {
    const batchId = await prepare(2);
    const old = await claimed();
    await service.cancel(batchId, 'test-key');
    await pool.execute('UPDATE batch_items SET lease_until = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 SECOND) WHERE item_id = ?', [old.item_id]);
    const recovered = await claimed();
    expect(recovered.item_id).toBe(old.item_id);
    await service.process(recovered);
    expect(await service.claimNext(randomUUID())).toBeNull();
    const info = await service.getRequired(batchId, 'test-key');
    expect(info.status).toBe('canceled');
    expect(info.processingCount).toBe(0);
    expect(info.canceledCount).toBe(1);
    expect(info.successCount).toBe(1);
  });

  it('writes concurrent ZIP downloads atomically and never caches a ZIP with missing output files', async () => {
    const batchId = await prepare();
    const item = await claimed();
    await service.process(item);
    const archives = await Promise.all(Array.from({ length: 4 }, () => service.batchDownload(batchId, 'test-key')));
    expect(archives.every((archive) => Object.values(unzipSync(archive!.buffer)).length === 1)).toBe(true);
    const [rows] = await pool.query<any[]>('SELECT output_path FROM batch_items WHERE item_id = ?', [item.item_id]);
    await rm(rows[0].output_path);
    const [batchRows] = await pool.query<any[]>('SELECT archive_path FROM batches WHERE batch_id = ?', [batchId]);
    await rm(batchRows[0].archive_path);
    await pool.execute('UPDATE batches SET archive_path = NULL WHERE batch_id = ?', [batchId]);
    await expect(service.batchDownload(batchId, 'test-key')).rejects.toThrow();
    const [after] = await pool.query<any[]>('SELECT archive_path FROM batches WHERE batch_id = ?', [batchId]);
    expect(after[0].archive_path).toBeNull();
  });

  it('fences an expired worker, preserves the new output and records the expired attempt', async () => {
    const batchId = await prepare();
    const old = await claimed();
    await pool.execute('UPDATE batch_items SET lease_until = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 SECOND) WHERE item_id = ?', [old.item_id]);
    const next = await claimed();
    sdk.rotate.mockResolvedValueOnce({ buffer: Buffer.from('%PDF new lease'), headers: { 'content-type': 'application/pdf' } });
    await service.process(next);
    sdk.rotate.mockResolvedValueOnce({ buffer: Buffer.from('%PDF stale lease'), headers: { 'content-type': 'application/pdf' } });
    await service.process(old);
    expect((await service.itemDownload(old.item_id, 'test-key'))!.buffer.toString()).toBe('%PDF new lease');
    const info = await service.getRequired(batchId, 'test-key');
    expect(info.status).toBe('success');
    expect(info.items[0].outputs).toHaveLength(1);
    const [attempts] = await pool.query<any[]>('SELECT status, failure_code FROM batch_attempts WHERE item_id = ? ORDER BY attempt_no', [old.item_id]);
    expect(attempts.map((attempt) => [attempt.status, attempt.failure_code])).toEqual([['failed', 'LEASE_EXPIRED'], ['success', null]]);
  });

  it('does not expose a half-written success manifest to a concurrent status reader', async () => {
    const batchId = await prepare();
    const item = await claimed();
    const transaction = client.transaction.bind(client);
    let reached!: () => void;
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { reached = resolve; });
    const pause = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(client, 'transaction').mockImplementation((work) => transaction((db) => work({
      query: db.query,
      execute: async (sql, params) => {
        const result = await db.execute(sql, params);
        if (sql.startsWith("UPDATE batch_items SET status = 'success'")) { reached(); await pause; }
        return result;
      },
    } as MysqlTransaction)));
    const processing = service.process(item);
    await barrier;
    try {
      const during = await service.getRequired(batchId, 'test-key');
      expect(during.status).toBe('processing');
      expect(during.items[0].status).toBe('processing');
      expect(during.items[0].outputs).toBeUndefined();
    } finally { resume(); }
    await processing;
    const after = await service.getRequired(batchId, 'test-key');
    expect(after.status).toBe('success');
    expect(after.items[0].outputs).toHaveLength(1);
  });
});
