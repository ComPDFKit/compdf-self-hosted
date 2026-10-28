// @vitest-environment happy-dom

import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_SECTIONS } from '@/config/convert-map';
import { DEFAULT_LOGO_URL, useBrandStore } from '@/stores/brand';
import en from '@/i18n/locales/en.json';
import zhcn from '@/i18n/locales/zh-cn.json';
import AppHeader from './AppHeader.vue';

vi.mock('@/lib/theme', () => ({ applyBrandTheme: vi.fn() }));
vi.mock('@/components/LangSwitch.vue', () => ({
  default: { template: '<button aria-label="Language"><slot name="icon" /></button>' },
}));

const wrappers: VueWrapper[] = [];

async function mountHeader(path = '/') {
  const pinia = createPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/pdf-tools/:convert', component: { template: '<div />' } },
      { path: '/admin', component: { template: '<div />' } },
    ],
  });
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en, 'zh-cn': zhcn },
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(AppHeader, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n] },
  });
  wrappers.push(wrapper);
  return { wrapper, router, i18n, brand: useBrandStore(pinia) };
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
});

describe('AppHeader navigation', () => {
  it('retains configured branding and the dashboard destination in the tools header', async () => {
    const { wrapper, brand } = await mountHeader();
    expect(wrapper.get('.brand-mark').attributes('src')).toBe(DEFAULT_LOGO_URL);

    brand.config = {
      ...brand.c,
      siteName: 'Private PDF',
      logoUrl: '/custom-logo.svg',
      docUrl: 'https://example.com/docs',
      themeColor: '#cc3300',
    };
    await flushPromises();

    expect(wrapper.get('.brand-name').text()).toBe('Private PDF');
    expect(wrapper.get('.brand-mark').attributes('src')).toBe('/custom-logo.svg');
    expect(wrapper.get('.brand').attributes('href')).toBe('/');
    expect(wrapper.get('.dashboard-link').attributes('href')).toBe('/admin');
  });

  it('opens only the hovered category and closes when the mouse leaves', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const { wrapper } = await mountHeader();
    const groups = wrapper.findAll('.nav-group');
    expect(groups).toHaveLength(5);
    expect(wrapper.findAll('.nav-dropdown').every((menu) => !menu.isVisible())).toBe(true);

    await groups[0]!.trigger('mouseenter');
    expect(groups[0]!.get('.nav-trigger').attributes('aria-expanded')).toBe('true');
    expect(groups[0]!.get('.nav-dropdown').isVisible()).toBe(true);
    expect(groups[0]!.findAll('.tool-link').map((link) => link.attributes('href')))
      .toEqual(TOOL_SECTIONS[0]!.tools.map((tool) => `/pdf-tools/${tool.slug}`));
    expect(groups[0]!.findAll('.tool-icon').every((icon) => !!icon.attributes('src'))).toBe(true);

    await groups[1]!.trigger('mouseenter');
    expect(groups[0]!.get('.nav-dropdown').isVisible()).toBe(false);
    expect(groups[1]!.get('.nav-dropdown').isVisible()).toBe(true);
    await groups[1]!.trigger('mouseleave');
    expect(groups[1]!.get('.nav-dropdown').isVisible()).toBe(false);
  });

  it('supports keyboard entry, Escape focus restoration and outside dismissal', async () => {
    const { wrapper } = await mountHeader();
    const trigger = wrapper.get('#header-trigger-0');
    (trigger.element as HTMLButtonElement).focus();
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('#header-tools-0 a').element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);

    await trigger.trigger('click');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
  });

  it('closes on tool selection and on subsequent route changes, and marks the current tool', async () => {
    const { wrapper, router } = await mountHeader();
    const trigger = wrapper.get('#header-trigger-0');
    await trigger.trigger('click');
    await wrapper.get('#header-tools-0 .tool-link').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/pdf-tools/pdf-to-word');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('#header-tools-0 .tool-link').attributes('aria-current')).toBe('page');
    expect(trigger.classes()).toContain('is-active');

    await trigger.trigger('click');
    await router.push('/pdf-tools/encrypt');
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('#header-trigger-4').classes()).toContain('is-active');
  });

  it('uses existing translations and respects the tools-enabled configuration', async () => {
    const { wrapper, i18n, brand } = await mountHeader();
    i18n.global.locale.value = 'zh-cn';
    await flushPromises();
    expect(wrapper.get('#header-trigger-0').text()).toBe(zhcn['pdfTools.sections.pdfToOthers']);
    expect(wrapper.get('#header-tools-0 .tool-link').text()).toBe(zhcn['pdfTools.tools.pdfToWord']);

    brand.config = { ...brand.c, compdfToolsEnabled: false };
    await flushPromises();
    expect(wrapper.find('.primary-nav').exists()).toBe(false);
    expect(wrapper.find('.dashboard-link').exists()).toBe(true);
  });

  it('omits empty categories and includes only tools available in the shared catalog', async () => {
    const section = TOOL_SECTIONS[0]!;
    const originalTools = section.tools;
    try {
      section.tools = originalTools.slice(1);
      const { wrapper } = await mountHeader();
      expect(wrapper.find('[href="/pdf-tools/pdf-to-word"]').exists()).toBe(false);
      expect(wrapper.findAll('#header-tools-0 .tool-link')).toHaveLength(originalTools.length - 1);

      section.tools = [];
      const { wrapper: emptyWrapper } = await mountHeader();
      expect(emptyWrapper.find('#header-trigger-0').exists()).toBe(false);
      expect(emptyWrapper.findAll('.nav-group')).toHaveLength(4);
    } finally {
      section.tools = originalTools;
    }
  });
});
