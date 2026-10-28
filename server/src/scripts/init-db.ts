/**
 * Idempotent first-boot database seeding. This script is independent of Nest DI.
 *
 * Flow:
 *   1. Wait for MySQL, retrying 30 times with a 1s delay.
 *   2. Apply ${INIT_SQL_PATH:-/configs/init.sql} only when the database has no
 *      schema_migrations baseline, even if the infrastructure already created
 *      the empty tracking table. Versioned databases are checked, not altered.
 *   3. Provision the API key: if API_KEY env is set, install that exact key
 *      (idempotent by sha256 hash); otherwise seed a random key on first boot
 *      and persist its plaintext for Web auto-injection. Once an active API key
 *      exists, this script will not auto-generate another one.
 *
 * The default Dashboard admin account is seeded here on first boot.
 * Re-running does not duplicate seed data or overwrite existing credentials.
 * The script runs only when executed directly; importing it is side-effect free.
 */
import { createHash } from 'crypto';
import { createPool, Pool } from 'mysql2/promise';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { ADMIN_PASSWORD, ADMIN_USERNAME, genApiKey, hashApiKey, hashPassword } from './credentials';

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 1000;
const PLAINTEXT_FILENAME = '.api-key-plaintext';
const DEFAULT_DATABASE_SCHEMA_VERSION = '1.1.0';

interface PoolLike {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<[T, unknown]>;
  execute: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export interface EnsureApiKeyResult {
  keyId: string;
  /** Only set when a random key was generated (printed once). null for env keys. */
  secret: string | null;
  fromEnv: boolean;
  inserted: boolean;
  /** True when an existing active key was updated to match API_KEY. */
  updatedExisting: boolean;
}

export interface EnsureDefaultAdminResult {
  username: string;
  password: string;
  inserted: boolean;
}

/** Register the schema version represented by init.sql without rewriting history. */
export async function ensureSchemaBaseline(
  pool: PoolLike,
  version = process.env.COMPDF_DB_SCHEMA_VERSION ?? DEFAULT_DATABASE_SCHEMA_VERSION,
  baselineSql = '',
): Promise<void> {
  assertSchemaVersion(version);
  // A fresh-schema baseline is not the SQL migration that ends at this version.
  const checksum = `baseline:${createHash('sha256').update(baselineSql).digest('hex')}`;
  await pool.execute(
    `INSERT INTO schema_migrations (version, checksum)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE version = version`,
    [version, checksum],
  );
}

export async function initializeSchema(
  pool: PoolLike,
  baselineSql: string,
  targetVersion = process.env.COMPDF_DB_SCHEMA_VERSION ?? DEFAULT_DATABASE_SCHEMA_VERSION,
): Promise<'initialized' | 'verified'> {
  assertSchemaVersion(targetVersion);
  const [tables] = await pool.query<Array<{ c: number }>>(
    `SELECT COUNT(*) AS c
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'`,
  );

  const hasMigrationTable = Number(tables[0]?.c ?? 0) > 0;
  const [rows] = hasMigrationTable
    ? await pool.query<Array<{ version: string }>>('SELECT version FROM schema_migrations')
    : [[]];

  // Infrastructure images can pre-create the tracking table without recording
  // a Server baseline. Treat that database as unversioned, just like a database
  // without the table; only recorded versions prevent replaying bootstrap SQL.
  if (rows.length === 0) {
    assertDatabaseAgnosticBaseline(baselineSql);
    await pool.query(baselineSql);
    await ensureApiKeyOwnershipSchema(pool);
    await ensureSchemaBaseline(pool, targetVersion, baselineSql);
    return 'initialized';
  }

  for (const row of rows) assertSchemaVersion(row.version);
  const currentVersion = rows.map((row) => row.version).sort(compareSchemaVersions).at(-1)!;
  if (currentVersion !== targetVersion) {
    throw new Error(
      `database schema ${currentVersion} does not match target ${targetVersion}; run npm run migrate:db`,
    );
  }
  return 'verified';
}

/** The connection's DATABASE_NAME is authoritative; baseline SQL must not override it. */
export function assertDatabaseAgnosticBaseline(baselineSql: string): void {
  const executableSql = baselineSql.replace(/^\s*--.*$/gm, '');
  if (/(?:^|;)\s*(?:CREATE\s+(?:DATABASE|SCHEMA)|USE\s+)/im.test(executableSql)) {
    throw new Error(
      'init.sql must not create or select a database; configure DATABASE_NAME and provision that database before startup',
    );
  }
}

function assertSchemaVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`invalid COMPDF_DB_SCHEMA_VERSION: ${version}`);
  }
}

function compareSchemaVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Add the API key creator column for deployments created before ownership tracking. */
async function ensureApiKeyOwnershipSchema(pool: PoolLike): Promise<void> {
  const [columns] = await pool.query<Array<{ c: number }>>(
    `SELECT COUNT(*) AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_keys' AND COLUMN_NAME = 'created_by_user_id'`,
  );
  if (Number(columns[0]?.c ?? 0) === 0) {
    await pool.execute('ALTER TABLE api_keys ADD COLUMN created_by_user_id BIGINT NULL');
  }
}

/** Existing deployment keys belong to the deployment administrator by default. */
export async function bindUnownedApiKeysToDefaultAdmin(pool: PoolLike): Promise<void> {
  const [admins] = await pool.query<Array<{ id: number }>>(
    'SELECT id FROM users WHERE role = ? ORDER BY id ASC LIMIT 1',
    ['admin'],
  );
  const adminId = admins[0]?.id;
  if (!adminId) return;
  await pool.execute(
    'UPDATE api_keys SET created_by_user_id = ? WHERE created_by_user_id IS NULL',
    [adminId],
  );
}

/**
 * Retain an uploaded avatar when a development database has been recreated but
 * the host-mounted storage directory is still present. Existing profile data is
 * never overwritten.
 */
export async function restoreAvatarPaths(pool: PoolLike): Promise<void> {
  const avatarDir = join(process.env.STORAGE_DIR ?? join(process.cwd(), 'storage'), 'avatars');
  let files: string[];
  try {
    files = readdirSync(avatarDir);
  } catch {
    return;
  }
  for (const file of files) {
    const match = file.match(/^(\d+)\.(png|jpg|webp)$/);
    if (!match) continue;
    await pool.execute(
      'UPDATE users SET avatar_path = ? WHERE id = ? AND avatar_path IS NULL',
      [file, Number(match[1])],
    );
  }
}

/**
 * Guarantee a default Dashboard admin account for new deployments. Existing
 * deployments are left untouched; we only create the account when no admin row
 * exists yet. Whether the login page still shows the built-in credentials is
 * decided later from login_records, not from the seed step itself.
 */
export async function ensureDefaultAdmin(pool: PoolLike): Promise<EnsureDefaultAdminResult> {
  const [rows] = await pool.query<Array<{ c: number }>>(
    'SELECT COUNT(*) AS c FROM users WHERE role = ?',
    ['admin'],
  );
  const hasAdmin = Number(rows[0]?.c ?? 0) > 0;

  if (!hasAdmin) {
    await pool.execute(
      'INSERT INTO users (username, password_hash, role, last_login_at) VALUES (?, ?, ?, NOW())',
      [ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD), 'admin'],
    );
  }

  return {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    inserted: !hasAdmin,
  };
}

/**
 * Provision the API key.
 * - envSecret set: install that key (idempotent — keyed by sha256 hash).
 *   keyId is derived as the first 16 hex of the hash (stable across restarts).
 * - envSecret set and a different active key exists: update that single row
 *   instead of inserting another API key.
 * - envSecret unset: seed a random key when no active API key exists. If an
 *   active key exists but its persisted plaintext is missing or stale, rotate
 *   that same row so ComPDF Web can recover without creating a second key.
 */
export async function ensureApiKey(
  pool: PoolLike,
  envSecret?: string,
): Promise<EnsureApiKeyResult | null> {
  if (envSecret) {
    const hash = hashApiKey(envSecret);
    const keyId = hash.slice(0, 16);
    const [rows] = await pool.query<Array<{ id: number }>>(
      'SELECT id FROM api_keys WHERE key_hash = ? LIMIT 1',
      [hash],
    );
    if (rows.length > 0) {
      return { keyId, secret: null, fromEnv: true, inserted: false, updatedExisting: false };
    }
    const [activeRows] = await pool.query<Array<{ id: number }>>(
      'SELECT id FROM api_keys WHERE status = 1 ORDER BY created_at ASC LIMIT 1',
      [],
    );
    if (activeRows.length > 0) {
      await pool.execute('UPDATE api_keys SET key_id = ?, key_hash = ?, status = 1 WHERE id = ?', [keyId, hash, activeRows[0].id]);
      return { keyId, secret: null, fromEnv: true, inserted: false, updatedExisting: true };
    }
    await pool.execute('INSERT INTO api_keys (key_id, key_hash) VALUES (?, ?)', [keyId, hash]);
    return { keyId, secret: null, fromEnv: true, inserted: true, updatedExisting: false };
  }

  const [rows] = await pool.query<Array<{ id: number; key_hash: string }>>(
    'SELECT id, key_hash FROM api_keys WHERE status = 1 LIMIT 1',
    [],
  );
  const activeKey = rows[0];
  if (activeKey) {
    const persistedSecret = readPersistedPlaintext();
    if (persistedSecret && hashApiKey(persistedSecret) === activeKey.key_hash) {
      return null;
    }
    const { keyId, secret } = genApiKey();
    await pool.execute(
      'UPDATE api_keys SET key_id = ?, key_hash = ?, status = 1 WHERE id = ?',
      [keyId, hashApiKey(secret), activeKey.id],
    );
    persistPlaintext(secret);
    return { keyId, secret, fromEnv: false, inserted: false, updatedExisting: true };
  }
  const { keyId, secret } = genApiKey();
  await pool.execute('INSERT INTO api_keys (key_id, key_hash) VALUES (?, ?)', [keyId, hashApiKey(secret)]);
  // Persist the plaintext to <storageDir>/.api-key-plaintext (0600) so the
  // running server can auto-inject it into the ComPDF Web SPA without the
  // operator having to copy it manually. Only written on first-boot generation
  // (env-provisioned keys are read directly from process.env.API_KEY at runtime).
  persistPlaintext(secret);
  return { keyId, secret, fromEnv: false, inserted: true, updatedExisting: false };
}

function plaintextPath(): string {
  const storageDir = process.env.STORAGE_DIR ?? join(process.cwd(), 'storage');
  return join(storageDir, PLAINTEXT_FILENAME);
}

function readPersistedPlaintext(): string | null {
  try {
    const secret = readFileSync(plaintextPath(), 'utf8').trim();
    return secret || null;
  } catch {
    return null;
  }
}

/**
 * Write the generated API key plaintext to <storageDir>/.api-key-plaintext
 * with 0600 perms. Best-effort: a write failure is logged but does not block
 * boot (the admin still has the printed secret and can set API_KEY env).
 */
function persistPlaintext(secret: string): void {
  const storageDir = process.env.STORAGE_DIR ?? join(process.cwd(), 'storage');
  const path = plaintextPath();
  try {
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(path, secret, { encoding: 'utf8', mode: 0o600 });
    // writeFileSync mode is subject to umask; chmod to be explicit.
    chmodSync(path, 0o600);
  } catch (err) {
    console.warn(`[init-db] could not persist api-key plaintext to ${path}: ${(err as Error).message}`);
    console.warn('[init-db] set API_KEY env to enable ComPDF Web auto-injection');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pool(): Pool {
  return createPool({
    host: process.env.DATABASE_HOST ?? 'compdf-infra',
    port: parseInt(process.env.DATABASE_PORT ?? '3306', 10),
    user: process.env.DATABASE_USER ?? 'compdfkit',
    password: process.env.DATABASE_PASSWORD ?? 'compdfkit-pass-2026',
    database: process.env.DATABASE_NAME ?? 'compdfkit',
    multipleStatements: true,
    charset: 'utf8mb4',
  });
}

async function waitForMysql(p: Pool): Promise<void> {
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const conn = await p.getConnection();
      try {
        await conn.ping();
        return;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.log(`[init-db] waiting for mysql (${i}/${MAX_RETRIES}): ${(err as Error).message}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`mysql unreachable after ${MAX_RETRIES} retries`);
}

function banner(title: string, lines: string[]): void {
  const bar = '='.repeat(50);
  console.log(bar);
  console.log(` ${title}`);
  for (const l of lines) console.log(`   ${l}`);
  console.log(bar);
}

async function run(): Promise<void> {
  const p = pool();
  try {
    await waitForMysql(p);

    const sqlPath = process.env.INIT_SQL_PATH ?? './configs/init.sql';
    if (!existsSync(sqlPath)) {
      throw new Error(`init.sql not found at ${sqlPath}`);
    }
    const sql = readFileSync(sqlPath, 'utf8');
    const schemaResult = await initializeSchema(p as unknown as PoolLike, sql);
    console.log(`[init-db] schema ${schemaResult}`);

    const admin = await ensureDefaultAdmin(p as unknown as PoolLike);
    if (admin.inserted) {
      banner('Default Dashboard admin account:', [
        `username: ${admin.username}`,
        `password: ${admin.password}`,
      ]);
    } else {
      console.log('[init-db] dashboard admin already present — skipping seed');
    }
    await restoreAvatarPaths(p as unknown as PoolLike);

    const result = await ensureApiKey(p as unknown as PoolLike, process.env.API_KEY);
    await bindUnownedApiKeysToDefaultAdmin(p as unknown as PoolLike);
    if (result === null) {
      console.log('[init-db] api key already present — skipping seed');
    } else if (result.fromEnv) {
      if (result.updatedExisting) {
        banner('API key from API_KEY env updated:', [`key_id: ${result.keyId}`]);
      } else if (result.inserted) {
        banner('API key from API_KEY env installed:', [`key_id: ${result.keyId}`]);
      } else {
        console.log(`[init-db] api key from API_KEY env already present (key_id: ${result.keyId})`);
      }
    } else if (result.updatedExisting) {
      banner('API key recovered after missing or stale plaintext:', [
        `key_id:    ${result.keyId}`,
        `x-api-key: ${result.secret}`,
      ]);
    } else {
      banner('First-boot API key (save now, shown once):', [
        `key_id:    ${result.keyId}`,
        `x-api-key: ${result.secret}`,
      ]);
    }
  } finally {
    await p.end().catch(() => undefined);
  }
}

const isMain = require.main === module;
if (isMain) {
  run().catch((err: unknown) => {
    console.error('[init-db] fatal:', err);
    process.exit(1);
  });
}

export { run };
