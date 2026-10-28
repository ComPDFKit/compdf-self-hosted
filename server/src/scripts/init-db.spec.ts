import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { assertDatabaseAgnosticBaseline, ensureSchemaBaseline, initializeSchema } from './init-db';

describe('assertDatabaseAgnosticBaseline', () => {
  it('accepts schema objects in the selected connection database', () => {
    expect(() => assertDatabaseAgnosticBaseline(
      '-- DATABASE_NAME is selected by the connection\nCREATE TABLE example (id INT);',
    )).not.toThrow();
  });

  it.each([
    'CREATE DATABASE other;',
    'CREATE SCHEMA other;',
    'USE other;',
    'SELECT 1; USE other;',
  ])('rejects a database-switching statement: %s', (sql) => {
    expect(() => assertDatabaseAgnosticBaseline(sql)).toThrow(
      'init.sql must not create or select a database',
    );
  });
});

describe('ensureSchemaBaseline', () => {
  it('records an idempotent versioned baseline', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await ensureSchemaBaseline({
      query: vi.fn(),
      execute,
    }, '4.1.0', 'CREATE TABLE example (id INT);');

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
    expect(execute.mock.calls[0][1]).toEqual([
      '4.1.0',
      `baseline:${createHash('sha256').update('CREATE TABLE example (id INT);').digest('hex')}`,
    ]);
  });

  it('rejects a malformed schema version before touching the database', async () => {
    const execute = vi.fn();

    await expect(ensureSchemaBaseline({
      query: vi.fn(),
      execute,
    }, 'latest')).rejects.toThrow('invalid COMPDF_DB_SCHEMA_VERSION');
    expect(execute).not.toHaveBeenCalled();
  });

  it('initializes and records a baseline only when the schema is unversioned', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ c: 0 }], undefined])
      .mockResolvedValueOnce([[], undefined])
      .mockResolvedValueOnce([[{ c: 1 }], undefined]);
    const execute = vi.fn().mockResolvedValue(undefined);

    await expect(initializeSchema({ query, execute }, 'CREATE TABLE example (id INT);', '4.1.0'))
      .resolves.toBe('initialized');

    expect(query.mock.calls[1][0]).toBe('CREATE TABLE example (id INT);');
    expect(execute.mock.calls.at(-1)?.[1]?.[0]).toBe('4.1.0');
  });

  it('does not replay baseline SQL for an already versioned database', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ c: 1 }], undefined])
      .mockResolvedValueOnce([[{ version: '4.1.0' }], undefined]);
    const execute = vi.fn();

    await expect(initializeSchema({ query, execute }, 'SHOULD NOT RUN;', '4.1.0'))
      .resolves.toBe('verified');

    expect(query).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('bootstraps an infrastructure database with an empty migration table', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ c: 1 }], undefined])
      .mockResolvedValueOnce([[], undefined])
      .mockResolvedValueOnce([[], undefined])
      .mockResolvedValueOnce([[{ c: 1 }], undefined]);
    const execute = vi.fn().mockResolvedValue(undefined);
    const baselineSql = 'CREATE TABLE IF NOT EXISTS example (id INT);';

    await expect(initializeSchema({ query, execute }, baselineSql, '4.1.0'))
      .resolves.toBe('initialized');

    expect(query.mock.calls[2][0]).toBe(baselineSql);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual([
      '4.1.0',
      `baseline:${createHash('sha256').update(baselineSql).digest('hex')}`,
    ]);
  });

  it('rejects database-switching SQL even when the migration table is empty', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ c: 1 }], undefined])
      .mockResolvedValueOnce([[], undefined]);
    const execute = vi.fn();

    await expect(initializeSchema({ query, execute }, 'USE wrong_database;', '4.1.0'))
      .rejects.toThrow('init.sql must not create or select a database');

    expect(query).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not apply database-switching SQL to an unversioned database', async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ c: 0 }], undefined]);
    const execute = vi.fn();

    await expect(initializeSchema({ query, execute }, 'USE wrong_database;', '4.1.0'))
      .rejects.toThrow('init.sql must not create or select a database');

    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires the controlled migration command when schema versions differ', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ c: 1 }], undefined])
      .mockResolvedValueOnce([[{ version: '4.1.0' }], undefined]);

    await expect(initializeSchema({ query, execute: vi.fn() }, '', '4.2.0'))
      .rejects.toThrow('run npm run migrate:db');
  });
});
