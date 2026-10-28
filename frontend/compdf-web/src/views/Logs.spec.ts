// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it, vi } from 'vitest';
import { dashboardApi, type LogEntry } from '@/api/dashboard';
import { formatDateTime } from '@/lib/format';
import zh from '@/i18n/locales/zh-cn.json';
import Logs from './Logs.vue';

vi.mock('@/api/dashboard', () => ({ dashboardApi: { logs: vi.fn() } }));

describe('API key operation logs', () => {
  it('shows user, timestamp, INFO, success and the view/copy summary', async () => {
    const createdAt = new Date().toISOString();
    const items: LogEntry[] = ['查看密钥', '复制密钥'].map((message, index) => ({
      id: index + 1, logType: 'user_action', operator: 'current-admin', createdAt,
      level: 'INFO', result: 'success', resultCategory: 'success', message,
      action: index === 0 ? 'view_api_key' : 'copy_api_key', target: 'test-key',
      method: null, endpoint: null, feature: null, fileInfo: null, statusCode: null, durationMs: null,
    }));
    vi.mocked(dashboardApi.logs).mockResolvedValue({ items, total: 2, page: 1, pageSize: 20 });
    const page = mount(Logs, {
      global: {
        plugins: [createI18n({ legacy: false, locale: 'zh-cn', messages: { 'zh-cn': zh } })],
        stubs: { Dialog: true, Select: true },
      },
    });
    try {
      await flushPromises();
      const rows = page.findAll('tbody tr');
      expect(rows).toHaveLength(2);
      for (const [index, row] of rows.entries()) {
        expect(row.findAll('td').slice(0, 6).map((cell) => cell.text())).toEqual([
          '用户操作', 'current-admin', formatDateTime(createdAt), zh['logs.level.INFO'],
          '成功', items[index]!.message,
        ]);
      }
    } finally {
      page.unmount();
    }
  });
});
