// @vitest-environment happy-dom
import { shallowMount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';
import WatermarkColorPicker from './WatermarkColorPicker.vue';
import en from '@/i18n/locales/en.json';

function mountPicker(disabled = false) {
  return shallowMount(WatermarkColorPicker, {
    props: { modelValue: '#396FFA', opacity: '1', disabled },
    global: { renderStubDefaultSlot: true, plugins: [createI18n({ legacy: false, locale: 'en', flatJson: true, messages: { en: { ...en } } })] },
  });
}

describe('watermark color and opacity binding', () => {
  it('splits CSS RGBA into the SDK hex color and independent opacity', async () => {
    const wrapper = mountPicker();
    await wrapper.get('input[aria-label="Font Color"]').setValue('rgba(255, 0, 0, 0.25)');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['#FF0000']);
    expect(wrapper.emitted('update:opacity')?.at(-1)).toEqual(['0.25']);
    wrapper.unmount();
  });

  it('reflects external opacity changes in the picker and keeps invalid drafts out of the model', async () => {
    const wrapper = mountPicker();
    await wrapper.setProps({ modelValue: '#FF0000', opacity: '0.4' });
    expect((wrapper.get('input[aria-label="Font Color"]').element as HTMLInputElement).value).toBe('rgba(255, 0, 0, 0.4)');
    await wrapper.get('input[aria-label="Font Color"]').setValue('not-a-color');
    await flushPromises();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect((wrapper.get('input[aria-label="Font Color"]').element as HTMLInputElement).value).toBe('rgba(255, 0, 0, 0.4)');
    wrapper.unmount();
  });

  it('preserves RGB when changing alpha and locks edits during processing', async () => {
    const wrapper = mountPicker();
    await wrapper.get('input[type="number"]').setValue('0.5');
    expect(wrapper.props('modelValue')).toBe('#396FFA');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(wrapper.emitted('update:opacity')?.at(-1)).toEqual(['0.5']);
    await wrapper.setProps({ disabled: true });
    expect(wrapper.get('.color-button').attributes('disabled')).toBeDefined();
    const before = wrapper.emitted('update:modelValue')?.length;
    await wrapper.get('input[aria-label="Font Color"]').setValue('#FFFFFF');
    expect(wrapper.emitted('update:modelValue')?.length).toBe(before);
    wrapper.unmount();
  });
});
