import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { MysqlClient } from '../../clients/mysql.client';
import { ApiKeyGuard } from './api-key.guard';

function contextFor(request: Record<string, any>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

describe('ApiKeyGuard', () => {
  it('updates last_used_at after successful API-key validation', async () => {
    const mysql = {
      query: vi.fn().mockResolvedValue([{
        key_id: 'key-1',
        key_hash: hash('secret'),
        status: 1,
        owner_username: 'admin',
      }]),
      execute: vi.fn().mockResolvedValue(undefined),
    };
    const request: Record<string, any> = { headers: { 'x-api-key': 'secret' } };
    const guard = new ApiKeyGuard(mysql as unknown as MysqlClient, {} as ConfigService);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(request.apiKeyId).toBe('key-1');
    expect(request.apiKeyOwner).toBe('admin');
    expect(mysql.execute).toHaveBeenCalledWith(
      'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_id = ?',
      ['key-1'],
    );
  });

  it('does not reject a valid request when the timestamp update fails', async () => {
    const mysql = {
      query: vi.fn().mockResolvedValue([{
        key_id: 'key-1',
        key_hash: hash('secret'),
        status: 1,
        owner_username: null,
      }]),
      execute: vi.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const request: Record<string, any> = { headers: { 'x-api-key': 'secret' } };
    const guard = new ApiKeyGuard(mysql as unknown as MysqlClient, {} as ConfigService);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
  });

  it('does not update the timestamp for an invalid API key', async () => {
    const mysql = {
      query: vi.fn().mockResolvedValue([]),
      execute: vi.fn(),
    };
    const request: Record<string, any> = { headers: { 'x-api-key': 'invalid' } };
    const guard = new ApiKeyGuard(mysql as unknown as MysqlClient, {} as ConfigService);

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mysql.execute).not.toHaveBeenCalled();
  });
});
