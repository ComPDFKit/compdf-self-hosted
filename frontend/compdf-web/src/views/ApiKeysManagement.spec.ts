// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { Check } from 'lucide-vue-next';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardApi } from '@/api/dashboard';
import { copyText } from '@/lib/clipboard';
import en from '@/i18n/locales/en.json';
import ApiKeysManagement from './ApiKeysManagement.vue';

vi.mock('@/api/dashboard', () => ({ dashboardApi: { apiKeys: vi.fn(), recordApiKeyAction: vi.fn() } }));
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }));

const key = 'test-api-key-for-clipboard-only';
let wrapper: VueWrapper | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(dashboardApi.apiKeys).mockResolvedValue([
    { keyId: 'test-key', key, status: 1, createdAt: '', lastUsedAt: null },
  ]);
  vi.mocked(copyText).mockResolvedValue();
  vi.mocked(dashboardApi.recordApiKeyAction).mockResolvedValue({ ok: true });
});

afterEach(() => {
  wrapper?.unmount();
  vi.useRealTimers();
});

async function mountPage() {
  wrapper = mount(ApiKeysManagement, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: { ...en } } })],
    },
  });
  await flushPromises();
  return wrapper;
}

describe('API key visibility and copying', () => {
  it('logs each reveal, but does not log page loading or hiding the key', async () => {
    const page = await mountPage();
    expect(dashboardApi.recordApiKeyAction).not.toHaveBeenCalled();
    const toggle = page.get('button[aria-label="Show API key"]');
    await toggle.trigger('click');
    await flushPromises();
    expect(dashboardApi.recordApiKeyAction).toHaveBeenCalledWith('test-key', 'view');
    await toggle.trigger('click');
    expect(dashboardApi.recordApiKeyAction).toHaveBeenCalledTimes(1);
    await toggle.trigger('click');
    expect(dashboardApi.recordApiKeyAction).toHaveBeenCalledTimes(2);
  });

  it.each(['view', 'copy'] as const)('reports a failed %s audit without treating the key operation as failed', async (action) => {
    vi.mocked(dashboardApi.recordApiKeyAction).mockRejectedValueOnce(new Error('Log unavailable'));
    const page = await mountPage();
    await page.get(action === 'view' ? 'button[aria-label="Show API key"]' : 'button[aria-label="Copy"]').trigger('click');
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toBe(en['apiKeys.auditFailed']);
    expect(dashboardApi.recordApiKeyAction).toHaveBeenCalledWith('test-key', action);
    if (action === 'view') expect(page.get('code').text()).toBe(key);
    else expect(page.findComponent(Check).exists()).toBe(true);
  });

  it('reveals the full key and hides it again while preserving copying', async () => {
    const page = await mountPage();
    const maskedKey = page.get('code').text();
    const toggle = page.get('button[aria-label="Show API key"]');
    expect(maskedKey).not.toBe(key);
    expect(toggle.attributes('aria-pressed')).toBe('false');
    await toggle.trigger('click');
    expect(page.get('code').text()).toBe(key);
    expect(toggle.attributes('aria-label')).toBe(en['apiKeys.hide']);
    expect(toggle.attributes('aria-pressed')).toBe('true');
    await page.get('button[aria-label="Copy"]').trigger('click');
    await flushPromises();
    expect(copyText).toHaveBeenCalledWith(key);
    await toggle.trigger('click');
    expect(page.get('code').text()).toBe(maskedKey);
    expect(toggle.attributes('aria-label')).toBe(en['apiKeys.show']);
    expect(toggle.attributes('aria-pressed')).toBe('false');
  });

  it('toggles each key independently', async () => {
    const secondKey = 'second-test-api-key-for-visibility';
    vi.mocked(dashboardApi.apiKeys).mockResolvedValue([
      { keyId: 'test-key', key, status: 1, createdAt: '', lastUsedAt: null },
      { keyId: 'second-key', key: secondKey, status: 1, createdAt: '', lastUsedAt: null },
    ]);
    const page = await mountPage();
    const toggles = page.findAll('button[aria-label="Show API key"]');
    await toggles[0]!.trigger('click');
    expect(page.findAll('code')[0]!.text()).toBe(key);
    expect(page.findAll('code')[1]!.text()).not.toBe(secondKey);
    await toggles[1]!.trigger('click');
    await toggles[0]!.trigger('click');
    expect(page.findAll('code')[0]!.text()).not.toBe(key);
    expect(page.findAll('code')[1]!.text()).toBe(secondKey);
  });

  it('disables revealing and copying when plaintext is unavailable', async () => {
    vi.mocked(dashboardApi.apiKeys).mockResolvedValue([
      { keyId: 'unavailable-key', key: null, status: 0, createdAt: '', lastUsedAt: null },
    ]);
    const page = await mountPage();
    const toggle = page.get('button[aria-label="Show API key"]');
    const copy = page.get('button[aria-label="Copy"]');
    expect(toggle.attributes('disabled')).toBeDefined();
    expect(copy.attributes('disabled')).toBeDefined();
    await toggle.trigger('click');
    await copy.trigger('click');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(copyText).not.toHaveBeenCalled();
    expect(dashboardApi.recordApiKeyAction).not.toHaveBeenCalled();
  });

  it('copies the full key through the HTTP-compatible helper while keeping the displayed key masked', async () => {
    const page = await mountPage();
    expect(page.get('code').text()).not.toBe(key);
    await page.get('button[aria-label="Copy"]').trigger('click');
    await flushPromises();
    expect(copyText).toHaveBeenCalledWith(key);
    expect(dashboardApi.recordApiKeyAction).toHaveBeenCalledWith('test-key', 'copy');
    expect(page.findComponent(Check).exists()).toBe(true);
  });

  it('does not show success until copying resolves', async () => {
    let finish!: () => void;
    vi.mocked(copyText).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const page = await mountPage();
    await page.get('button[aria-label="Copy"]').trigger('click');
    expect(page.findComponent(Check).exists()).toBe(false);
    expect(dashboardApi.recordApiKeyAction).not.toHaveBeenCalled();
    finish();
    await flushPromises();
    expect(page.findComponent(Check).exists()).toBe(true);
    expect(dashboardApi.recordApiKeyAction).toHaveBeenCalledWith('test-key', 'copy');
  });

  it('shows a localized failure and no success check when copying is rejected', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('Clipboard unavailable'));
    const page = await mountPage();
    await page.get('button[aria-label="Copy"]').trigger('click');
    await flushPromises();
    expect(page.findComponent(Check).exists()).toBe(false);
    expect(page.get('[role="alert"]').text()).toBe(en['apiKeys.copyFailed']);
    expect(page.text()).not.toContain(key);
    expect(dashboardApi.recordApiKeyAction).not.toHaveBeenCalled();
    await page.get('button[aria-label="Copy"]').trigger('click');
    await flushPromises();
    expect(page.find('[role="alert"]').exists()).toBe(false);
    expect(page.findComponent(Check).exists()).toBe(true);
  });
});
