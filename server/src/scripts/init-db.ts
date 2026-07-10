/**
 * Idempotent first-boot database seeding. This script is independent of Nest DI.
 *
 * Flow:
 *   1. Wait for MySQL, retrying 30 times with a 1s delay.
 *   2. Apply ${INIT_SQL_PATH:-/configs/init.sql}; the SQL is idempotent.
 *   3. Provision the API key: if API_KEY env is set, install that exact key
 *      (idempotent by sha256 hash); otherwise seed a random key on first boot
 *      and persist its plaintext for Web auto-injection. Once an active API key
 *      exists, this script will not auto-generate another one.
 *
 * The first admin is NOT seeded here — it is created interactively via the
 * default Dashboard admin account is seeded here on first boot.
 * Re-running does not duplicate seed data or overwrite existing credentials.
 * The script runs only when executed directly; importing it is side-effect free.
 */
import { createPool, Pool } from 'mysql2/promise';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ADMIN_PASSWORD, ADMIN_USERNAME, genApiKey, hashApiKey, hashPassword } from './credentials';

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 1000;
const PLAINTEXT_FILENAME = '.api-key-plaintext';

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
 * - envSecret unset: seed a random key only when there is no active API key.
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

  const [rows] = await pool.query<Array<{ id: number }>>(
    'SELECT id FROM api_keys WHERE status = 1 LIMIT 1',
    [],
  );
  const activeKeyExists = rows.length > 0;
  if (activeKeyExists) return null;
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
    await p.query(sql);
    console.log('[init-db] schema applied (idempotent)');

    const admin = await ensureDefaultAdmin(p as unknown as PoolLike);
    if (admin.inserted) {
      banner('Default Dashboard admin account:', [
        `username: ${admin.username}`,
        `password: ${admin.password}`,
      ]);
    } else {
      console.log('[init-db] dashboard admin already present — skipping seed');
    }

    const result = await ensureApiKey(p as unknown as PoolLike, process.env.API_KEY);
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
