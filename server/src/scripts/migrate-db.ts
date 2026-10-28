import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createPool, Pool } from 'mysql2/promise';

const MIGRATION_NAME = /^(\d+\.\d+\.\d+)-to-(\d+\.\d+\.\d+)\.sql$/;
const MIGRATION_LOCK = 'compdf-schema-migration';

interface PoolLike {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<[T, unknown]>;
  execute: (sql: string, params?: unknown[]) => Promise<unknown>;
  beginTransaction?: () => Promise<void>;
  commit?: () => Promise<void>;
  rollback?: () => Promise<void>;
}

export interface MigrationStep {
  from: string;
  to: string;
  path: string;
  checksum: string;
  sql: string;
  transactional: boolean;
}

interface AppliedMigration {
  version: string;
  checksum: string;
}

export function discoverMigrationPath(directory: string, current: string, target: string): MigrationStep[] {
  assertStableVersion(current, 'current schema version');
  assertStableVersion(target, 'target schema version');
  if (compareStableVersions(current, target) > 0) {
    throw new Error(`database downgrade is not supported: ${current} -> ${target}`);
  }
  if (current === target) return [];
  if (!existsSync(directory)) throw new Error(`migrations directory not found: ${directory}`);

  const migrations = discoverMigrations(directory);
  const bySource = new Map<string, MigrationStep>();
  for (const step of migrations) {
    if (bySource.has(step.from)) {
      throw new Error(`ambiguous migrations from ${step.from}`);
    }
    bySource.set(step.from, step);
  }

  const result: MigrationStep[] = [];
  const visited = new Set<string>();
  let version = current;
  while (version !== target) {
    if (visited.has(version)) throw new Error(`migration cycle detected at ${version}`);
    visited.add(version);
    const step = bySource.get(version);
    if (!step) throw new Error(`no continuous migration path from ${version} to ${target}`);
    if (compareStableVersions(step.to, target) > 0) {
      throw new Error(`migration ${step.from} -> ${step.to} overshoots target ${target}`);
    }
    result.push(step);
    version = step.to;
  }
  return result;
}

export function discoverMigrations(directory: string): MigrationStep[] {
  if (!existsSync(directory)) throw new Error(`migrations directory not found: ${directory}`);
  const result: MigrationStep[] = [];
  for (const name of readdirSync(directory)) {
    const match = name.match(MIGRATION_NAME);
    if (!match) continue;
    const path = join(directory, name);
    const sql = readFileSync(path, 'utf8');
    if (!sql.trim()) throw new Error(`migration is empty: ${name}`);
    const step: MigrationStep = {
      from: match[1],
      to: match[2],
      path,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
      transactional: /^\s*--\s*compdf:transactional\s*$/im.test(sql),
    };
    if (compareStableVersions(step.from, step.to) >= 0) {
      throw new Error(`migration must move forward: ${name}`);
    }
    result.push(step);
  }
  return result.sort((left, right) => compareStableVersions(left.from, right.from));
}

export async function verifyAppliedMigrationChecksums(
  pool: PoolLike,
  migrations: MigrationStep[],
): Promise<void> {
  const [rows] = await pool.query<AppliedMigration[]>(
    'SELECT version, checksum FROM schema_migrations ORDER BY applied_at ASC, version ASC',
  );
  const expected = new Map(migrations.map((step) => [step.to, step.checksum]));
  for (const row of rows) {
    if (/^baseline:[a-f0-9]{64}$/.test(row.checksum)) continue;
    const expectedChecksum = expected.get(row.version);
    if (expectedChecksum && expectedChecksum !== row.checksum) {
      throw new Error(`checksum mismatch for applied migration ${row.version}`);
    }
  }
}

export async function acquireMigrationLock(pool: PoolLike): Promise<void> {
  const [rows] = await pool.query<Array<{ acquired: number | null }>>(
    'SELECT GET_LOCK(?, 0) AS acquired',
    [MIGRATION_LOCK],
  );
  if (Number(rows[0]?.acquired ?? 0) !== 1) {
    throw new Error('another database migration is already running');
  }
}

export async function releaseMigrationLock(pool: PoolLike): Promise<void> {
  await pool.query('SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK]);
}

export async function applyMigrations(pool: PoolLike, steps: MigrationStep[]): Promise<void> {
  const [rows] = await pool.query<AppliedMigration[]>(
    'SELECT version, checksum FROM schema_migrations ORDER BY applied_at ASC, version ASC',
  );
  const applied = new Map(rows.map((row) => [row.version, row.checksum]));

  for (const step of steps) {
    const existingChecksum = applied.get(step.to);
    if (existingChecksum) {
      if (existingChecksum !== step.checksum) {
        throw new Error(`checksum mismatch for applied migration ${step.to}`);
      }
      continue;
    }
    if (step.transactional) {
      if (!pool.beginTransaction || !pool.commit || !pool.rollback) {
        throw new Error(`transactional migration ${step.from} -> ${step.to} requires a dedicated connection`);
      }
      await pool.beginTransaction();
      try {
        await pool.query(step.sql);
        await recordMigration(pool, step);
        await pool.commit();
      } catch (error) {
        await pool.rollback().catch(() => undefined);
        throw error;
      }
    } else {
      await pool.query(step.sql);
      await recordMigration(pool, step);
    }
    applied.set(step.to, step.checksum);
  }
}

async function recordMigration(pool: PoolLike, step: MigrationStep): Promise<void> {
  await pool.execute(
    'INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)',
    [step.to, step.checksum],
  );
}

export async function currentSchemaVersion(pool: PoolLike): Promise<string> {
  const [rows] = await pool.query<Array<{ version: string }>>(
    'SELECT version FROM schema_migrations',
  );
  if (rows.length === 0) throw new Error('database has no schema migration baseline');
  for (const row of rows) assertStableVersion(row.version, 'applied schema version');
  return rows.map((row) => row.version).sort(compareStableVersions).at(-1)!;
}

async function run(): Promise<void> {
  const target = process.env.COMPDF_DB_SCHEMA_VERSION;
  if (!target) throw new Error('COMPDF_DB_SCHEMA_VERSION is required');
  const directory = process.env.MIGRATIONS_PATH ?? defaultMigrationsPath();
  const pool = databasePool();
  let connection: Awaited<ReturnType<Pool['getConnection']>> | undefined;
  try {
    connection = await pool.getConnection();
    const runner = connection as unknown as PoolLike;
    await acquireMigrationLock(runner);
    const current = await currentSchemaVersion(runner);
    const migrations = discoverMigrations(directory);
    await verifyAppliedMigrationChecksums(runner, migrations);
    const steps = discoverMigrationPath(directory, current, target);
    await applyMigrations(runner, steps);
    console.log(`[migrate-db] schema ${current} -> ${target}; applied ${steps.length} migration(s)`);
  } finally {
    if (connection) {
      await releaseMigrationLock(connection as unknown as PoolLike).catch(() => undefined);
      connection.release();
    }
    await pool.end().catch(() => undefined);
  }
}

export function defaultMigrationsPath(cwd = process.cwd()): string {
  const packaged = join(cwd, 'release', 'migrations');
  return existsSync(packaged) ? packaged : join(cwd, '..', 'migrations');
}

function databasePool(): Pool {
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

function assertStableVersion(value: string, label: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${label} is invalid: ${value}`);
}

function compareStableVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error('[migrate-db] fatal:', (error as Error).message);
    process.exit(1);
  });
}
