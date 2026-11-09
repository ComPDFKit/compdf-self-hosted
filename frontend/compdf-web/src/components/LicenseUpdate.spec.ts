// @vitest-environment happy-dom
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LicenseUpdate from './LicenseUpdate.vue';
import { dashboardApi, type LicenseUpdateStatus } from '@/api/dashboard';
import en from '@/i18n/locales/en.json';
import zhcn from '@/i18n/locales/zh-cn.json';
import zhtw from '@/i18n/locales/zh-tw.json';
import ja from '@/i18n/locales/ja.json';
import ko from '@/i18n/locales/ko.json';
import th from '@/i18n/locales/th.json';
import es from '@/i18n/locales/es.json';

vi.mock('@/api/dashboard', () => ({
  dashboardApi: { licenseUpdateStatus: vi.fn(), updateLicense: vi.fn(), recoverLicense: vi.fn() },
}));

const rawError = 'PDF SDK cannot validate this XML key format. Use a PDF SDK compatible license or update the compdf-app engine; runtime license was not changed';
const catalogs = { en, 'zh-cn': zhcn, 'zh-tw': zhtw, ja, ko, th, es };
const failedJob: LicenseUpdateStatus = { requestId: 'license-test', phase: 'FAILED', updatedAt: '2026-11-05T00:00:00Z', error: rawError };
let wrapper: VueWrapper;

function mountUpdate(locale = 'zh-cn') {
  const i18n = createI18n({
    legacy: false, locale, flatJson: true,
    messages: Object.fromEntries(Object.entries(catalogs).map(([code, messages]) => [code, { ...messages }])),
  });
  wrapper = shallowMount(LicenseUpdate, { global: { renderStubDefaultSlot: true, plugins: [i18n], stubs: { Dialog: { template: '<div><slot /></div>' } } } });
  return i18n;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(dashboardApi.licenseUpdateStatus).mockResolvedValue(failedJob);
});
afterEach(() => {
  wrapper?.unmount();
  vi.useRealTimers();
});

describe('LicenseUpdate', () => {
  it.each(Object.entries(catalogs))('localizes persisted job errors in %s', async (locale, messages) => {
    mountUpdate(locale);
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain(messages['license.update.error.sdkXmlUnsupported']);
    expect(wrapper.get('[role="status"]').text()).toContain(messages['license.update.phase.failed']);
    if (locale !== 'en') expect(wrapper.text()).not.toContain(rawError);
  });

  it('reacts to language changes without refetching a persisted job', async () => {
    const i18n = mountUpdate();
    await flushPromises();
    i18n.global.locale.value = 'ja';
    await nextTick();
    expect(wrapper.get('[role="status"]').text()).toContain(ja['license.update.error.sdkXmlUnsupported']);
    expect(dashboardApi.licenseUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it('localizes polling errors and clears them after a successful poll', async () => {
    vi.mocked(dashboardApi.licenseUpdateStatus).mockRejectedValueOnce({ message: 'License operation status is unavailable; maintenance remains active.' });
    mountUpdate();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe(zhcn['license.update.error.statusUnavailable']);
    await vi.advanceTimersByTimeAsync(2500);
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('localizes upload errors and keeps them reactive to the current language', async () => {
    vi.mocked(dashboardApi.licenseUpdateStatus).mockResolvedValue(null);
    vi.mocked(dashboardApi.updateLicense).mockRejectedValue({ message: rawError });
    const i18n = mountUpdate();
    await flushPromises();
    const input = wrapper.get('input[type="file"]');
    const file = new File(['<license><key>test</key></license>'], 'license.xml', { type: 'application/xml' });
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await wrapper.findAll('button').find((button) => button.text() === zhcn['license.update.confirmAction'])!.trigger('click');
    await flushPromises();
    expect(dashboardApi.updateLicense).toHaveBeenCalledWith(file);
    expect(wrapper.text()).toContain(zhcn['license.update.error.sdkXmlUnsupported']);
    i18n.global.locale.value = 'es';
    await nextTick();
    expect(wrapper.text()).toContain(es['license.update.error.sdkXmlUnsupported']);
    expect(wrapper.text()).not.toContain(rawError);
  });

  it('localizes recovery request errors', async () => {
    vi.mocked(dashboardApi.licenseUpdateStatus).mockResolvedValue({ ...failedJob, phase: 'RECOVERY_REQUIRED' });
    vi.mocked(dashboardApi.recoverLicense).mockRejectedValue({ message: 'No matching license recovery is available.' });
    mountUpdate();
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === zhcn['license.update.restore'])!.trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe(zhcn['license.update.error.noRecovery']);
  });

  it('does not expose unknown upstream errors', async () => {
    vi.mocked(dashboardApi.licenseUpdateStatus).mockResolvedValue({ ...failedJob, error: 'Unexpected /private/path error' });
    mountUpdate();
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain(zhcn['license.update.error.unknown']);
    expect(wrapper.text()).not.toContain('/private/path');
  });
});
