// @vitest-environment happy-dom
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';
import StampSettings from './StampSettings.vue';
import { defaultStampParameter, buildStampRequest, type StampKind, type StampParameter } from '@/config/stamp-schema';
import en from '@/i18n/locales/en.json';

function mountSettings(kind: StampKind) {
  let wrapper: VueWrapper<InstanceType<typeof StampSettings>>;
  wrapper = shallowMount(StampSettings, {
    props: { kind, modelValue: defaultStampParameter(kind), 'onUpdate:modelValue': (value) => wrapper.setProps({ modelValue: value }) },
    global: { plugins: [createI18n({ legacy: false, locale: 'en', flatJson: true, messages: { en: { ...en } } })] },
  });
  return wrapper;
}

describe('stamp settings controls', () => {
  it('keeps region content when switching positions and inserts page numbers into the active region', async () => {
    const wrapper = mountSettings('headers-footers');
    await wrapper.get('textarea').setValue('Header');
    await wrapper.findAll('.position-grid button').find((button) => button.text() === 'Footer Right')!.trigger('click');
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    await wrapper.findAll('.insert-actions button')[0]!.trigger('click');
    await flushPromises();
    const state = wrapper.props('modelValue') as StampParameter;
    expect(state.regions).toMatchObject({ topCenter: 'Header', bottomRight: '<<1>>' });
    await wrapper.get('input[placeholder="All Pages"]').setValue('1、3');
    const payload = buildStampRequest('headers-footers', wrapper.props('modelValue') as StampParameter);
    expect(payload).toMatchObject({ pages: '1,3', regions: { topCenter: 'Header', bottomRight: '<<1>>' } });
    expect(wrapper.find('input[type="radio"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows padded Bates examples using the selected file page range and maps picker alpha to SDK color', async () => {
    const wrapper = mountSettings('bates');
    const state = { ...(wrapper.props('modelValue') as StampParameter), startNumber: 42, prefix: 'CASE-', suffix: '-A' };
    await wrapper.setProps({ modelValue: state });
    expect(wrapper.findAll('output').map((output) => output.text())).toEqual(['CASE-000042-A']);
    await wrapper.get('input[placeholder="All Pages"]').setValue('1,3');
    expect(wrapper.findAll('output').map((output) => output.text())).toEqual(['CASE-000042-A', 'CASE-000043-A']);
    wrapper.getComponent({ name: 'WatermarkColorPicker' }).vm.$emit('update:modelValue', '#396FFA');
    wrapper.getComponent({ name: 'WatermarkColorPicker' }).vm.$emit('update:opacity', '0.5');
    await flushPromises();
    expect(buildStampRequest('bates', wrapper.props('modelValue') as StampParameter)).toMatchObject({ textColor: '#80396FFA', digits: 6, startNumber: 42 });
    await wrapper.setProps({ disabled: true });
    await wrapper.findAll('.position-grid button')[0]!.trigger('click');
    expect((wrapper.props('modelValue') as StampParameter).position).toBe('bottomRight');
    expect(wrapper.getComponent({ name: 'WatermarkColorPicker' }).props('disabled')).toBe(true);
    wrapper.unmount();
  });
});
