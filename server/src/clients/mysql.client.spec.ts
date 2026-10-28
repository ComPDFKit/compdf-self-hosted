import { ConfigService } from '@nestjs/config';
import mysql from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MysqlClient } from './mysql.client';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined), release: vi.fn(), destroy: vi.fn(),
    query: vi.fn().mockResolvedValue([[{ id: 1 }]]), execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
  };
  vi.spyOn(mysql, 'createPool').mockReturnValue({ getConnection: vi.fn().mockResolvedValue(connection) } as any);
  return { client: new MysqlClient({ get: () => undefined } as unknown as ConfigService), connection };
}

describe('MysqlClient transactions', () => {
  it('runs reads and writes on one connection, then commits and releases', async () => {
    const { client, connection } = fixture();
    expect(await client.transaction(async (db) => {
      const rows = await db.query('SELECT id FROM test WHERE id = ?', [1]);
      await db.execute('UPDATE test SET id = ?', [2]);
      return rows;
    })).toEqual([{ id: 1 }]);
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.query).toHaveBeenCalledWith('SELECT id FROM test WHERE id = ?', [1]);
    expect(connection.execute).toHaveBeenCalledWith('UPDATE test SET id = ?', [2]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it.each(['statement', 'commit', 'begin'])('rolls back and releases after a %s failure', async (where) => {
    const { client, connection } = fixture();
    const error = new Error(where);
    if (where === 'statement') connection.execute.mockRejectedValue(error);
    if (where === 'commit') connection.commit.mockRejectedValue(error);
    if (where === 'begin') connection.beginTransaction.mockRejectedValue(error);
    await expect(client.transaction((db) => db.execute('UPDATE test SET id = ?', [2]))).rejects.toBe(error);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('preserves the original error and destroys the connection if rollback also fails', async () => {
    const { client, connection } = fixture();
    const original = new Error('original');
    connection.rollback.mockRejectedValue(new Error('rollback'));
    await expect(client.transaction(async () => { throw original; })).rejects.toBe(original);
    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
});
