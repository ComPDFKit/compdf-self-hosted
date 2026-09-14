// @vitest-environment happy-dom

import { shallowMount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/api/client';
import UploadPanel from './UploadPanel.vue';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return {
    ...actual,
    apiClient: { post: vi.fn() },
  };
});

function mountCompressPanel() {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        pdfToolDetail: {
          upload: {
            selectFile: 'Select File',
            dragDrop: 'Drop files here',
            errors: { apiCodes: { fileEmpty: 'File cannot be empty.' } },
          },
        },
      },
    },
  });

  return shallowMount(UploadPanel, {
    props: {
      fromType: 'pdf',
      toType: 'compress',
      mode: 'single',
      accept: '.pdf',
      toolSlug: 'compress',
      endpoint: { kind: 'pdf', op: 'compress' },
    },
    global: { plugins: [i18n] },
  });
}

describe('UploadPanel file selection', () => {
  it('rejects a zero-byte PDF before it is uploaded', async () => {
    const wrapper = mountCompressPanel();
    const input = wrapper.get('input[name="file"]');
    const emptyPdf = new File([], 'empty.pdf', { type: 'application/pdf' });
    Object.defineProperty(input.element, 'files', { value: [emptyPdf] });

    await input.trigger('change');

    expect(wrapper.text()).toContain('File cannot be empty.');
    expect(vi.mocked(apiClient.post)).not.toHaveBeenCalled();
  });
});
