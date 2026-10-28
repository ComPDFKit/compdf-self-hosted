import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireMigrationLock,
  applyMigrations,
  defaultMigrationsPath,
  discoverMigrationPath,
  discoverMigrations,
  verifyAppliedMigrationChecksums,
} from './migrate-db';

describe('database migration runner', () => {
  it('discovers a continuous migration path in version order', () => {
    const directory = temporaryMigrations({
      '4.1.0-to-4.2.0.sql': 'ALTER TABLE users ADD COLUMN example_a INT NULL;',
      '4.2.0-to-4.3.0.sql': 'ALTER TABLE users ADD COLUMN example_b INT NULL;',
    });

    const steps = discoverMigrationPath(directory, '4.1.0', '4.3.0');

    expect(steps.map((step) => `${step.from}->${step.to}`)).toEqual(['4.1.0->4.2.0', '4.2.0->4.3.0']);
    expect(steps[0].checksum).toBe(createHash('sha256').update(steps[0].sql).digest('hex'));
  });

  it('rejects a missing or ambiguous path', () => {
    const missing = temporaryMigrations({ '4.2.0-to-4.3.0.sql': 'SELECT 1;' });
    expect(() => discoverMigrationPath(missing, '4.1.0', '4.3.0')).toThrow('no continuous migration path');

    const ambiguous = temporaryMigrations({
      '4.1.0-to-4.2.0.sql': 'SELECT 1;',
      '4.1.0-to-4.3.0.sql': 'SELECT 2;',
    });
    expect(() => discoverMigrationPath(ambiguous, '4.1.0', '4.3.0')).toThrow('ambiguous migrations');
  });

  it('rejects database downgrade paths', () => {
    expect(() => discoverMigrationPath(temporaryMigrations({}), '4.2.0', '4.1.0'))
      .toThrow('database downgrade is not supported');
  });

  it('records a migration only after its SQL succeeds', async () => {
    const step = discoverMigrationPath(
      temporaryMigrations({ '4.1.0-to-4.2.0.sql': 'ALTER TABLE users ADD COLUMN example INT NULL;' }),
      '4.1.0',
      '4.2.0',
    )[0];
    const query = vi.fn()
      .mockResolvedValueOnce([[{ version: '4.1.0', checksum: 'baseline:4.1.0' }], undefined])
      .mockResolvedValueOnce([[], undefined]);
    const execute = vi.fn().mockResolvedValue(undefined);

    await applyMigrations({ query, execute }, [step]);

    expect(query.mock.calls[1][0]).toBe(step.sql);
    expect(execute).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)',
      ['4.2.0', step.checksum],
    );
  });

  it('does not record a failed migration', async () => {
    const step = discoverMigrationPath(
      temporaryMigrations({ '4.1.0-to-4.2.0.sql': 'INVALID SQL;' }),
      '4.1.0',
      '4.2.0',
    )[0];
    const query = vi.fn()
      .mockResolvedValueOnce([[{ version: '4.1.0', checksum: 'baseline:4.1.0' }], undefined])
      .mockRejectedValueOnce(new Error('migration failed'));
    const execute = vi.fn();

    await expect(applyMigrations({ query, execute }, [step])).rejects.toThrow('migration failed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips an already applied migration when its checksum matches', async () => {
    const step = discoverMigrationPath(
      temporaryMigrations({ '4.1.0-to-4.2.0.sql': 'SELECT 1;' }),
      '4.1.0',
      '4.2.0',
    )[0];
    const query = vi.fn().mockResolvedValueOnce([[
      { version: '4.2.0', checksum: step.checksum },
    ], undefined]);
    const execute = vi.fn();

    await applyMigrations({ query, execute }, [step]);

    expect(query).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('commits marked migrations and their records in one transaction', async () => {
    const step = discoverMigrationPath(
      temporaryMigrations({
        '4.1.0-to-4.2.0.sql': '-- compdf:transactional\nUPDATE system_settings SET dark_mode = 0;',
      }),
      '4.1.0',
      '4.2.0',
    )[0];
    const query = vi.fn()
      .mockResolvedValueOnce([[{ version: '4.1.0', checksum: 'baseline' }], undefined])
      .mockResolvedValueOnce([[], undefined]);
    const beginTransaction = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn().mockResolvedValue(undefined);
    const rollback = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(undefined);

    await applyMigrations({ query, execute, beginTransaction, commit, rollback }, [step]);

    expect(step.transactional).toBe(true);
    expect(beginTransaction).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back a marked migration when recording fails', async () => {
    const step = discoverMigrationPath(
      temporaryMigrations({
        '4.1.0-to-4.2.0.sql': '-- compdf:transactional\nUPDATE system_settings SET dark_mode = 0;',
      }),
      '4.1.0',
      '4.2.0',
    )[0];
    const query = vi.fn()
      .mockResolvedValueOnce([[{ version: '4.1.0', checksum: 'baseline' }], undefined])
      .mockResolvedValueOnce([[], undefined]);
    const rollback = vi.fn().mockResolvedValue(undefined);

    await expect(applyMigrations({
      query,
      execute: vi.fn().mockRejectedValueOnce(new Error('record failed')),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn(),
      rollback,
    }, [step])).rejects.toThrow('record failed');

    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rejects checksum drift in an already applied migration', async () => {
    const migrations = discoverMigrations(temporaryMigrations({
      '4.1.0-to-4.2.0.sql': 'SELECT 1;',
    }));
    const query = vi.fn().mockResolvedValueOnce([[
      { version: '4.1.0', checksum: 'baseline' },
      { version: '4.2.0', checksum: 'changed' },
    ], undefined]);

    await expect(verifyAppliedMigrationChecksums({ query, execute: vi.fn() }, migrations))
      .rejects.toThrow('checksum mismatch for applied migration 4.2.0');
  });

  it('accepts a fresh baseline at a migration target while still rejecting later drift', async () => {
    const migrations = discoverMigrations(temporaryMigrations({
      '1.0.0-to-1.1.0.sql': 'SELECT 1;',
      '1.1.0-to-1.2.0.sql': 'SELECT 2;',
    }));
    const baseline = { version: '1.1.0', checksum: `baseline:${'a'.repeat(64)}` };
    const query = vi.fn()
      .mockResolvedValueOnce([[baseline], undefined])
      .mockResolvedValueOnce([[baseline, { version: '1.2.0', checksum: 'changed' }], undefined]);

    await expect(verifyAppliedMigrationChecksums({ query, execute: vi.fn() }, migrations))
      .resolves.toBeUndefined();
    await expect(verifyAppliedMigrationChecksums({ query, execute: vi.fn() }, migrations))
      .rejects.toThrow('checksum mismatch for applied migration 1.2.0');
  });

  it('refuses to run while another migration owns the database lock', async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ acquired: 0 }], undefined]);

    await expect(acquireMigrationLock({ query, execute: vi.fn() }))
      .rejects.toThrow('another database migration is already running');
  });

  it('resolves source-checkout migrations when packaged assets are absent', () => {
    expect(defaultMigrationsPath(join('workspace', 'server')))
      .toBe(join('workspace', 'migrations'));
  });
});

function temporaryMigrations(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'compdf-migration-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(directory, name), sql);
  return directory;
}
