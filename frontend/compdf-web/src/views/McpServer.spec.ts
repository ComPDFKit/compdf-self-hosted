// @vitest-environment happy-dom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import McpServer from './McpServer.vue';
import { dashboardApi, type McpConfiguration } from '@/api/dashboard';
import { copyText } from '@/lib/clipboard';
import en from '@/i18n/locales/en.json';
import ja from '@/i18n/locales/ja.json';
import th from '@/i18n/locales/th.json';

vi.mock('@/api/dashboard', () => ({ dashboardApi: { mcpConfiguration: vi.fn(), mcpStatus: vi.fn() } }));
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }));

const configuration: McpConfiguration = {
  enabled: true, url: 'https://pdf.example.com/mcp', transport: 'streamable-http',
  authentication: { header: 'x-api-key', credential: 'API Access Key' },
  tools: [], limits: { maxInlineFileBytes: 4, maxFileBytes: 100, maxFiles: 10, maxTotalBytes: 1000 },
  clients: {
    claudeDesktop: { mcpServers: { compdf: { command: 'node', args: ['<ABSOLUTE_PATH>/server/dist/src/mcp/mcp-stdio.js'] } } },
    claudeCode: { mcpServers: { compdf: { type: 'http', url: 'https://pdf.example.com/mcp', headers: { 'x-api-key': '${COMPDF_API_KEY}' } } } },
    vscode: { servers: { compdf: { type: 'http', url: 'https://pdf.example.com/mcp' } } },
    codexToml: '[mcp_servers.compdf]\nurl = "https://pdf.example.com/mcp"\nenv_http_headers = { "x-api-key" = "COMPDF_API_KEY" }\n',
  },
};
const wrappers: VueWrapper[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dashboardApi.mcpConfiguration).mockResolvedValue(configuration);
  vi.mocked(dashboardApi.mcpStatus).mockResolvedValue({ status: 'running', checkedAt: '2026-10-14T00:00:00Z' });
  vi.mocked(copyText).mockResolvedValue();
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

async function mountPage(locale = 'en') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/admin/mcp', name: 'mcp', component: McpServer },
    { path: '/admin/api-keys', name: 'api-keys', component: { template: '<div />' } },
  ] });
  await router.push('/admin/mcp');
  await router.isReady();
  const wrapper = mount(McpServer, { global: { plugins: [
    router,
    createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en: { ...en }, ja: { ...ja }, th: { ...th } } }),
  ] } });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe('MCP Server management page', () => {
  it.each([['ja', ja], ['th', th]] as const)('renders supplied %s translations with the application i18n settings', async (locale, messages) => {
    const wrapper = await mountPage(locale);
    expect(wrapper.get('.mcp-integration-card h2').text()).toBe(messages['mcp.integration']);
    expect(wrapper.get('.mcp-key-notice p').text()).toBe(messages['mcp.apiKeyNote']);
    expect(wrapper.get('.mcp-status').text()).toContain(messages['mcp.status.running']);
  });
  it('loads the real configuration and status and links to API Key management', async () => {
    const wrapper = await mountPage();
    expect(dashboardApi.mcpConfiguration).toHaveBeenCalledOnce();
    expect(dashboardApi.mcpStatus).toHaveBeenCalledOnce();
    expect(wrapper.get<HTMLInputElement>('#mcp-url').element.value).toBe(configuration.url);
    expect(wrapper.get('.mcp-status').text()).toContain('Running');
    expect(wrapper.get('.mcp-key-link').attributes('href')).toBe('/admin/api-keys');
    expect(wrapper.get('pre').text()).toBe(configuration.clients.codexToml.trimEnd());
  });

  it('switches between four file formats and copies the backend template exactly', async () => {
    const wrapper = await mountPage();
    const cases = [
      ['Claude Desktop', 'claude_desktop_config.json', 'claudeDesktop'],
      ['Claude Code', '.mcp.json', 'claudeCode'],
      ['VS Code', '.vscode/mcp.json', 'vscode'],
    ] as const;
    for (const [label, file, id] of cases) {
      const tab = wrapper.findAll('[role="tab"]').find((item) => item.text() === label)!;
      await tab.trigger('click');
      expect(wrapper.get('.mcp-file-tag').text()).toBe(file);
      expect(wrapper.get('pre').text()).toBe(JSON.stringify(configuration.clients[id], null, 2));
      expect(wrapper.get('.mcp-verification').text()).toContain(label);
      await wrapper.get('.mcp-code-heading button').trigger('click');
      await flushPromises();
      expect(copyText).toHaveBeenLastCalledWith(JSON.stringify(configuration.clients[id], null, 2));
    }
    await wrapper.get('.mcp-url-box button').trigger('click');
    expect(copyText).toHaveBeenLastCalledWith(configuration.url);
  });

  it.each(['not_enabled', 'error'] as const)('displays %s from the status API', async (status) => {
    vi.mocked(dashboardApi.mcpStatus).mockResolvedValue({ status, checkedAt: '' });
    const wrapper = await mountPage();
    expect(wrapper.get('.mcp-status').classes()).toContain(`mcp-status--${status}`);
  });

  it('provides retry after a configuration failure without showing stale templates', async () => {
    vi.mocked(dashboardApi.mcpConfiguration).mockRejectedValueOnce(new Error('offline'));
    const wrapper = await mountPage();
    expect(wrapper.find('pre').exists()).toBe(false);
    expect(wrapper.find('.mcp-error').exists()).toBe(true);
    await wrapper.get('.mcp-error button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.mcp-error').exists()).toBe(false);
    expect(wrapper.get('pre').text()).toContain('[mcp_servers.compdf]');
  });

  it('shows a copy failure without claiming the configuration was copied', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('permission denied'));
    const wrapper = await mountPage();
    await wrapper.get('.mcp-code-heading button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.mcp-copy-error').exists()).toBe(true);
    expect(wrapper.get('.mcp-code-heading button').text()).toBe('Copy');
  });

  it('supports keyboard navigation between client tabs', async () => {
    const wrapper = await mountPage();
    await wrapper.get('#mcp-tab-codex').trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.get('#mcp-tab-vscode').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('.mcp-file-tag').text()).toBe('.vscode/mcp.json');
  });
});
