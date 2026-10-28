import { describe, expect, it, vi } from 'vitest';
import { UpdateCheckService } from './update-check.service';
import { RedisClient } from '../clients/redis.client';
import { SettingsFileSyncService } from './settings-file-sync.service';

function subject(url = 'https://raw.githubusercontent.com/ComPDFKit/compdf-self-hosted/updates/stable/release.json') {
  const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) };
  const settings = { getUpdatesConfig: () => ({ enabled: true, checkUrl: url }) };
  const service = new UpdateCheckService(redis as unknown as RedisClient, settings as SettingsFileSyncService);
  const get = vi.fn();
  Object.assign(service, { http: { get } });
  return { service, redis, get };
}

describe('production release checks', () => {
  it('reports 1.1.0 as current when the published release is also 1.1.0', async () => {
    const { service, get } = subject();
    get.mockResolvedValue({ data: { version: '1.1.0', status: 'active' } });
    expect(await service.getStatus('1.1.0')).toMatchObject({ current: '1.1.0', latest: '1.1.0', updateAvailable: false });
  });

  it('offers a newer release and its immutable Server image', async () => {
    const { service, get } = subject();
    const image = { name: 'compdfkit/compdf-server', tag: '1.2.0', digest: `sha256:${'a'.repeat(64)}` };
    get.mockResolvedValue({ data: { version: '1.2.0', images: { server: image } } });
    expect(await service.getStatus('1.1.0')).toMatchObject({ latest: '1.2.0', updateAvailable: true, image: `${image.name}:${image.tag}@${image.digest}` });
  });

  it('keeps a failed request unknown instead of claiming the installation is current', async () => {
    const { service, get } = subject();
    get.mockRejectedValue(new Error('network unavailable'));
    expect(await service.getStatus('1.1.0')).toMatchObject({ latest: null, updateAvailable: false });
  });

  it.each([
    { version: '1.2.0', status: 'withdrawn' },
    { version: '1.2.0', status: 'paused' },
    { version: '1.2.0', expiresAt: '2000-01-01T00:00:00Z' },
    { version: 'test-release' },
  ])('rejects inactive or invalid metadata: %j', async (data) => {
    const { service, get } = subject();
    get.mockResolvedValue({ data });
    expect((await service.getStatus('1.1.0')).latest).toBeNull();
  });

  it('isolates cached manifests by source and ignores the old global test cache', async () => {
    const first = subject('https://example.com/first/release.json');
    const second = subject('https://example.com/second/release.json');
    for (const test of [first, second]) {
      test.get.mockResolvedValue({ data: { version: '1.1.0' } });
      await test.service.getStatus('1.1.0');
    }
    expect(first.redis.get.mock.calls[0][0]).toMatch(/^update:manifest:v2:/);
    expect(first.redis.get.mock.calls[0][0]).not.toBe(second.redis.get.mock.calls[0][0]);
  });
});
