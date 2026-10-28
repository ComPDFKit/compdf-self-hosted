// @vitest-environment happy-dom
import { shallowMount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';
import { buildRequest, defaultParameter } from '@/config/param-schema';
import WatermarkSettings from './WatermarkSettings.vue';
import en from '@/i18n/locales/en.json';

describe('watermark form', () => {
  it('preserves watermark request fields with the new paired controls and page selection', async () => {
    const parameter = defaultParameter();
    const wrapper = shallowMount(WatermarkSettings, { props: { parameter }, global: { plugins: [createI18n({ legacy: false, locale: 'en', flatJson: true, messages: { en: { ...en } } })] } });
    const fields = wrapper.findAll('label.watermark-field');
    await fields.find((field) => field.text() === 'Watermark Text')!.get('input').setValue('CONFIDENTIAL');
    await fields.find((field) => field.text() === 'Font Size')!.get('input').setValue('18');
    await wrapper.get('input[aria-label="Page Range"]').setValue('1,3');
    wrapper.getComponent({ name: 'WatermarkColorPicker' }).vm.$emit('update:modelValue', '#396FFA');
    wrapper.getComponent({ name: 'WatermarkColorPicker' }).vm.$emit('update:opacity', '0.4');
    const request = buildRequest({ fromType: 'pdf', toType: 'addWatermark', parameter, password: '', files: [] });
    expect(request.payload).toMatchObject({ type: 'text', text: 'CONFIDENTIAL', fontSize: 18, fontColor: '#396FFA', opacity: 0.4, pages: '1,3' });
    await wrapper.get('input[aria-label="Page Range"]').setValue('');
    expect(parameter.pageRanges).toBe('');
    await wrapper.setProps({ disabled: true });
    expect(wrapper.findAll('select').every((select) => select.attributes('disabled') !== undefined)).toBe(true);
    expect(wrapper.getComponent({ name: 'WatermarkColorPicker' }).props('disabled')).toBe(true);
    wrapper.unmount();
  });
});
