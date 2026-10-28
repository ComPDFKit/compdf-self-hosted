import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { AdminPayload } from '../auth/guards/jwt-auth.guard';
import { DashboardController } from './dashboard.controller';

describe('update backup', () => {
  it('waits up to 120 seconds for the backup and returns its verified result', async () => {
    const result = { status: 'complete', manifest: { backupId: 'backup-test' } };
    const updater = { post: vi.fn().mockResolvedValue({ statusCode: 200, body: { exitCode: 0, result } }) };
    const dashboard = { recordUserAction: vi.fn().mockResolvedValue(undefined) };
    const controller = new DashboardController(
      dashboard as never, {} as never, {} as never, new ConfigService(),
      {} as never, {} as never, {} as never, updater as never,
    );
    const dto = { currentVersion: '4.2.1', requestId: 'backup-test', approve: true, maintenanceConfirmed: true };
    const req = { user: { username: 'admin' } } as Request & { user: AdminPayload };

    await expect(controller.backupForUpdate(dto, req)).resolves.toEqual(result);
    const [path, body, timeout] = updater.post.mock.calls[0];
    expect(path).toBe('/v1/backup');
    expect(body).toEqual(dto);
    expect(timeout).toBe(120_000);
    expect(dashboard.recordUserAction).toHaveBeenCalled();
  });
});
