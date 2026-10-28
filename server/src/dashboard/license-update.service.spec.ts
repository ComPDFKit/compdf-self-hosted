import { ConfigService } from '@nestjs/config';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeModeService } from '../runtime/runtime-mode.service';
import { LicenseUpdateService } from './license-update.service';

const file = { originalname: 'license.xml', size: 30, buffer: Buffer.from('<license><key>x</key></license>') } as Express.Multer.File;
function fixture(drained = true) {
  const config = { get: () => mkdtemp } as unknown as ConfigService;
  const mkdtemp = mkdtempSync(join(tmpdir(), 'license-update-'));
  const mode = new RuntimeModeService(config);
  const updater = { get: vi.fn().mockResolvedValue({ statusCode: 200, body: { exitCode: 0, result: {} } }), post: vi.fn() };
  const drain = { waitForDrain: vi.fn().mockResolvedValue({ drained }) };
  const audit = { recordUserAction: vi.fn() };
  const service = new LicenseUpdateService(config, updater as never, mode, drain as never, audit as never);
  return { service, updater, mode, drain };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('runtime license update orchestration', () => {
  it('rejects missing approval and oversize files before maintenance', async () => {
    const { service, mode, updater } = fixture();
    await expect(service.start(file, 'false', 'admin')).rejects.toThrow();
    await expect(service.start({ ...file, size: 65537 }, 'true', 'admin')).rejects.toThrow();
    expect(updater.get).not.toHaveBeenCalled(); expect(mode.getState().mode).toBe('normal');
  });
  it('does not replace the license if tasks remain active', async () => {
    const { service, mode, updater } = fixture(false);
    await service.start(file, 'true', 'admin'); await tick();
    expect(updater.post).not.toHaveBeenCalled(); expect(mode.getState().mode).toBe('normal');
    expect((await service.status())?.phase).toBe('FAILED');
  });
  it('stays in maintenance on lost response and reconciles completion', async () => {
    const { service, mode, updater } = fixture();
    updater.post.mockRejectedValue(new Error('connection lost'));
    const job = await service.start(file, 'true', 'admin'); await tick();
    expect(mode.getState().mode).toBe('maintenance');
    updater.get.mockResolvedValue({ statusCode: 200, body: { exitCode: 0, result: { ...job, phase: 'SUCCEEDED' } } });
    expect((await service.status())?.phase).toBe('SUCCEEDED');
    expect(mode.getState().mode).toBe('normal');
  });
  it('keeps maintenance on failed recovery, and rejects concurrent uploads', async () => {
    const { service, mode, updater } = fixture();
    updater.post.mockImplementation(async (_path, body) => ({ statusCode: 202, body: { exitCode: 0, result: { requestId: body.requestId, phase: 'RESTARTING' } } }));
    const job = await service.start(file, 'true', 'admin'); await tick();
    await expect(service.start(file, 'true', 'admin')).rejects.toThrow('maintenance');
    updater.get.mockResolvedValue({ statusCode: 200, body: { exitCode: 0, result: { ...job, phase: 'RECOVERY_REQUIRED' } } });
    expect((await service.status())?.phase).toBe('RECOVERY_REQUIRED'); expect(mode.getState().mode).toBe('maintenance');
  });
});
