/**
 * CLI: reset an admin's password. Runs outside Nest DI (raw mysql2 pool), like
 * init-db.ts. The new password is printed once; last_login_at is set to NULL so
 * the admin is forced to change it on next login (temporary credential).
 *
 * Usage:
 *   ts-node src/scripts/reset-password.ts [--username <name>] [--password <pwd>]
 *
 * --username defaults to the first admin row. --password defaults to a generated
 * strong random value.
 *
 * The testable core is resetPassword(); run() is a thin argv/pool/stdio wrapper.
 */
import { createPool, Pool, ResultSetHeader } from 'mysql2/promise';
import { genPassword, hashPassword } from './credentials';

export interface ResetOptions {
  username?: string;
  password?: string;
}

export interface ResetResult {
  username: string;
  password: string;
}

interface PoolLike {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<[T, unknown]>;
  execute: (sql: string, params?: unknown[]) => Promise<[ResultSetHeader, unknown]>;
}

/**
 * Reset one user's password. If username is omitted, targets the first admin.
 * If password is omitted, generates a strong random one. Sets last_login_at=NULL
 * to force a change on next login and increments token_version to invalidate all
 * previously issued admin-session JWTs for that user.
 */
export async function resetPassword(pool: PoolLike, opts: ResetOptions): Promise<ResetResult> {
  let username = opts.username;

  if (!username) {
    const [rows] = await pool.query<Array<{ username: string }>>(
      "SELECT username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1",
      [],
    );
    if (rows.length === 0) {
      throw new Error('no admin user exists; pass --username to target a specific account');
    }
    username = rows[0].username;
  } else {
    const [rows] = await pool.query<Array<{ id: number }>>(
      'SELECT id FROM users WHERE username = ? LIMIT 1',
      [username],
    );
    if (rows.length === 0) {
      throw new Error(`user "${username}" not found`);
    }
  }

  const password = opts.password ?? genPassword();
  const hash = hashPassword(password);
  await pool.execute(
    'UPDATE users SET password_hash = ?, last_login_at = NULL, token_version = token_version + 1 WHERE username = ?',
    [hash, username],
  );
  return { username, password };
}

function parseArgs(argv: string[]): ResetOptions {
  const opts: ResetOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--username' || a === '-u') opts.username = argv[++i];
    else if (a === '--password' || a === '-p') opts.password = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: reset-password [--username <name>] [--password <pwd>]');
      console.log('  --username  target user (default: first admin)');
      console.log('  --password  new password (default: generated, printed once)');
      process.exit(0);
    }
  }
  return opts;
}

function banner(title: string, lines: string[]): void {
  const bar = '='.repeat(50);
  console.log(bar);
  console.log(` ${title}`);
  for (const l of lines) console.log(`   ${l}`);
  console.log(bar);
}

function pool(): Pool {
  return createPool({
    host: process.env.DATABASE_HOST ?? 'compdf-infra',
    port: parseInt(process.env.DATABASE_PORT ?? '3306', 10),
    user: process.env.DATABASE_USER ?? 'compdfkit',
    password: process.env.DATABASE_PASSWORD ?? 'compdfkit-pass-2026',
    database: process.env.DATABASE_NAME ?? 'compdfkit',
    charset: 'utf8mb4',
  });
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const p = pool();
  try {
    // PoolLike is a test seam (the unit test passes a vi.fn mock). The real
    // mysql2 Pool is structurally compatible at runtime; the TS mismatch is
    // only in the execute() param-type narrowing (ExecuteValues vs unknown[]).
    const result = await resetPassword(p as unknown as PoolLike, opts);
    // Best-effort audit row (operator=system; no admin session during CLI use).
    await p
      .execute(
        "INSERT INTO operation_logs (log_type, operator, level, result, result_category, action, target, message) VALUES ('system', 'system', 'INFO', 'success', 'success', 'password_reset', ?, ?)",
        [result.username, `reset_password: ${result.username}`],
      )
      .catch(() => undefined);
    banner('Admin password reset (forced change on next login):', [
      `username: ${result.username}`,
      `password: ${result.password}`,
    ]);
  } finally {
    await p.end().catch(() => undefined);
  }
}

const isMain = require.main === module;
if (isMain) {
  run().catch((err: unknown) => {
    console.error('[reset-password] fatal:', err);
    process.exit(1);
  });
}

export { run };
