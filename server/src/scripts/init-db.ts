/**
 * Idempotent first-boot database seeding. This script is independent of Nest DI.
 *
 * Flow:
 *   1. Wait for MySQL, retrying 30 times with a 1s delay.
 *   2. Apply ${INIT_SQL_PATH:-/configs/init.sql}; the SQL is idempotent.
 *   3. If no admin user exists, generate a password, hash it, and print it once.
 *   4. If no active API key exists, generate keyId + secret, hash it, and print
 *      the secret once.
 *
 * Re-running does not duplicate seed data or overwrite existing credentials.
 * The script runs only when executed directly; importing it is side-effect free.
 */
import { createPool, Pool } from 'mysql2/promise';
import { existsSync, readFileSync } from 'fs';
import {
  ADMIN_USERNAME,
  genPassword,
  genApiKey,
  hashPassword,
  hashApiKey,
} from './credentials';

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 1000;

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

    const sqlPath = process.env.INIT_SQL_PATH ?? '/configs/init.sql';
    if (!existsSync(sqlPath)) {
      throw new Error(`init.sql not found at ${sqlPath}`);
    }
    const sql = readFileSync(sqlPath, 'utf8');
    await p.query(sql);
    console.log('[init-db] schema applied (idempotent)');

    const [adminRows] = await p.query(
      'SELECT id FROM users WHERE username = ?',
      [ADMIN_USERNAME],
    );
    if ((adminRows as Array<unknown>).length === 0) {
      const password = genPassword();
      await p.execute(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
        [ADMIN_USERNAME, hashPassword(password)],
      );
      banner('First-boot admin credentials (save now, shown once):', [
        `username: ${ADMIN_USERNAME}`,
        `password: ${password}`,
      ]);
    } else {
      console.log('[init-db] admin user already present — skipping seed');
    }

    const [keyRows] = await p.query(
      'SELECT id FROM api_keys WHERE status = 1 LIMIT 1',
    );
    if ((keyRows as Array<unknown>).length === 0) {
      const { keyId, secret } = genApiKey();
      await p.execute(
        'INSERT INTO api_keys (key_id, key_hash) VALUES (?, ?)',
        [keyId, hashApiKey(secret)],
      );
      banner('First-boot API key (save now, shown once):', [
        `key_id:    ${keyId}`,
        `x-api-key: ${secret}`,
      ]);
    } else {
      console.log('[init-db] api key already present — skipping seed');
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
