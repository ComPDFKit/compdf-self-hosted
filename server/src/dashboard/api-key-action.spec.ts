import { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard, type AdminPayload } from '../auth/guards/jwt-auth.guard';
import { makeGlobalValidationPipe } from '../common/pipes/validation.pipe';
import { DashboardController } from './dashboard.controller';
import { ApiKeyActionDto } from './dashboard.dto';
import { DashboardService } from './dashboard.service';

const plaintext = 'test-key-for-audit-only';
const keyRow = {
  key_id: 'test-key', key_hash: createHash('sha256').update(plaintext).digest('hex'),
  status: 1, created_at: new Date('2026-10-22T04:00:00Z'), last_used_at: null,
};

function fixture() {
  const mysql = { query: vi.fn().mockResolvedValue([keyRow]), execute: vi.fn().mockResolvedValue({}) };
  const keys = { getPlaintextKey: vi.fn().mockReturnValue(plaintext) };
  const service = new DashboardService(mysql as never, {} as never, keys as never);
  return { mysql, keys, service };
}

describe('API key action audit', () => {
  it.each(['view', 'copy'] as const)('records %s with the requested log fields and no secret', async (action) => {
    const { mysql, service } = fixture();
    await service.recordApiKeyAction('current-admin', { keyId: 'test-key', action });
    expect(mysql.execute).toHaveBeenCalledTimes(1);
    const [sql, values] = mysql.execute.mock.calls[0];
    expect(sql).toContain("VALUES ('user_action', ?, 'INFO', 'success', 'success', ?, ?, ?)");
    expect(values).toEqual(['current-admin', `${action}_api_key`, 'test-key', action === 'copy' ? '复制密钥' : '查看密钥']);
    expect(JSON.stringify(mysql.execute.mock.calls)).not.toContain(plaintext);
  });

  it.each(['missing', 'disabled', 'unavailable'] as const)('rejects a %s key without a success log', async (state) => {
    const { mysql, keys, service } = fixture();
    if (state === 'missing') mysql.query.mockResolvedValue([]);
    if (state === 'disabled') mysql.query.mockResolvedValue([{ ...keyRow, status: 0 }]);
    if (state === 'unavailable') keys.getPlaintextKey.mockReturnValue(null);
    await expect(service.recordApiKeyAction('admin', { keyId: 'test-key', action: 'view' })).rejects.toThrow('API key is unavailable');
    expect(mysql.execute).not.toHaveBeenCalled();
  });

  it('reports a failed audit write instead of returning success', async () => {
    const { mysql, service } = fixture();
    mysql.execute.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(service.recordApiKeyAction('admin', { keyId: 'test-key', action: 'copy' })).rejects.toThrow('Database unavailable');
  });

  it('uses the authenticated username and keeps the route under the JWT guard', async () => {
    const dashboard = { recordApiKeyAction: vi.fn().mockResolvedValue(undefined) };
    const controller = new DashboardController(
      dashboard as never, {} as never, {} as never, new ConfigService(),
      {} as never, {} as never, {} as never, {} as never,
    );
    const dto = await makeGlobalValidationPipe().transform(
      { keyId: 'test-key', action: 'copy', operator: 'forged-admin', message: plaintext, createdAt: '2000-01-01' },
      { type: 'body', metatype: ApiKeyActionDto },
    );
    expect(dto).toEqual({ keyId: 'test-key', action: 'copy' });
    const req = { user: { username: 'current-admin' } } as Request & { user: AdminPayload };
    await expect(controller.recordApiKeyAction(dto, req)).resolves.toEqual({ ok: true });
    expect(dashboard.recordApiKeyAction).toHaveBeenCalledWith('current-admin', dto);
    expect(Reflect.getMetadata(GUARDS_METADATA, DashboardController)).toContain(JwtAuthGuard);
  });

  it.each([
    { keyId: 'test-key', action: 'delete' },
    { keyId: '', action: 'view' },
    { keyId: 'x'.repeat(33), action: 'copy' },
    { keyId: 'test-key' },
  ])('validates action requests: %j', async (body) => {
    await expect(makeGlobalValidationPipe().transform(body, { type: 'body', metatype: ApiKeyActionDto })).rejects.toThrow();
  });

  it('returns the saved audit fields and timestamp through the logs API', async () => {
    const { mysql, service } = fixture();
    const now = new Date();
    mysql.query.mockResolvedValueOnce([{ c: 1 }]).mockResolvedValueOnce([{
      id: 1, log_type: 'user_action', operator: 'current-admin', level: 'INFO',
      result: 'success', result_category: 'success', action: 'copy_api_key',
      target: 'test-key', message: '复制密钥', created_at: now,
    }]);
    const result = await service.getLogs({ logType: 'user_action', level: 'INFO' });
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      logType: 'user_action', operator: 'current-admin', level: 'INFO', result: 'success',
      message: '复制密钥', createdAt: now.toISOString(),
    });
  });
});
