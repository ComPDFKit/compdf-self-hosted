// @vitest-environment happy-dom
import { flushPromises, shallowMount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';
import ParamForm from './ParamForm.vue';
import { buildRequest, defaultParameter } from '@/config/param-schema';
import { Select, SelectItem } from '@/components/ui/select';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import ja from '@/i18n/locales/ja.json';
import ko from '@/i18n/locales/ko.json';
import th from '@/i18n/locales/th.json';
import zhCn from '@/i18n/locales/zh-cn.json';
import zhTw from '@/i18n/locales/zh-tw.json';

const messages = { en, es, ja, ko, th, 'zh-cn': zhCn, 'zh-tw': zhTw };

function mountForm(standard = 'pdfa1a', locale: keyof typeof messages = 'en', toType = 'pdfa') {
  return shallowMount(ParamForm, {
    props: {
      fromType: 'pdf', toType, batch: true, files: [],
      parameter: { ...defaultParameter(), pdfStandard: standard }, password: '', isCsvMerge: '0',
    },
    global: {
      renderStubDefaultSlot: true,
      stubs: { TooltipProvider: { inheritAttrs: false, template: '<slot />' } },
      plugins: [createI18n({ legacy: false, locale, flatJson: true, messages: { [locale]: { ...messages[locale] } } })],
    },
  });
}

describe('PDF standards settings', () => {
  it.each(['pdfa1a', 'pdfa1b', 'pdfa2a', 'pdfa2u', 'pdfa2b', 'pdfx4', 'pdfe1'])(
    'hides PDF/UA metadata for %s', (standard) => {
      const wrapper = mountForm(standard);
      expect(wrapper.findAll('.setting-label').map((label) => label.text())).toEqual([
        en['pdfToolDetail.upload.settings.pdfStandard'],
        en['pdfToolDetail.upload.settings.iccProfile'],
      ]);
      expect(wrapper.find('input[type="text"]').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it('shows title and language only for PDF/UA and preserves them when switching standards', async () => {
    const wrapper = mountForm('pdfua1');
    expect(wrapper.findAll('.setting-label').map((label) => label.text())).toContain(en['pdfToolDetail.upload.settings.outputLanguage']);
    await wrapper.get('input[type="text"]').setValue('Accessible report');
    expect(wrapper.props('parameter').outputTitle).toBe('Accessible report');
    await wrapper.setProps({ parameter: { ...wrapper.props('parameter'), pdfStandard: 'pdfa1a' } });
    expect(wrapper.find('input[type="text"]').exists()).toBe(false);
    await wrapper.setProps({ parameter: { ...wrapper.props('parameter'), pdfStandard: 'pdfua1' }, converting: true });
    expect((wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe('Accessible report');
    expect(wrapper.get('input[type="text"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it.each(Object.keys(messages) as (keyof typeof messages)[])('renders exactly the translated punctuation in %s', (locale) => {
    const wrapper = mountForm('pdfua1', locale);
    expect(wrapper.findAll('.setting-label').map((label) => label.text())).toEqual(
      (['pdfStandard', 'outputTitle', 'outputLanguage', 'iccProfile'] as const).map(
        (key) => messages[locale][`pdfToolDetail.upload.settings.${key}` as const],
      ),
    );
    wrapper.unmount();
  });
});


describe('blank page size settings', () => {
  it.each(Object.keys(messages) as (keyof typeof messages)[])('includes the localized Letter option in %s', (locale) => {
    const wrapper = mountForm('pdfa1a', locale, 'insert');
    const options = wrapper.findAllComponents(SelectItem);
    expect(options.map((option) => option.props('value'))).toEqual(['a4', 'a3', 'letter', 'legal', 'custom']);
    expect(options.find((option) => option.props('value') === 'letter')?.text()).toBe('Letter');
    wrapper.unmount();
  });

  it.each([
    ['a4', '595', '842'],
    ['a3', '842', '1191'],
    ['letter', '612', '792'],
    ['legal', '612', '1008'],
  ])('selecting %s applies the matching dimensions to the insertion request', async (size, width, height) => {
    const wrapper = mountForm('pdfa1a', 'en', 'insert');
    await wrapper.setProps({ parameter: { ...defaultParameter(), insertPageSize: 'custom', insertWidth: '100', insertHeight: '200' } });
    wrapper.getComponent(Select).vm.$emit('update:modelValue', size);
    await flushPromises();
    const parameter = wrapper.props('parameter');
    expect(parameter).toMatchObject({ insertPageSize: size, insertWidth: width, insertHeight: height });
    const result = buildRequest({ fromType: 'pdf', toType: 'insert', parameter, password: '', files: [] });
    expect(result.payload).toMatchObject({ actionType: 'BLANK', count: 1, width: Number(width), height: Number(height) });
    expect(wrapper.find('.dimension-row').exists()).toBe(false);
    wrapper.unmount();
  });

  it('retains the Letter dimensions when switching to custom size', async () => {
    const wrapper = mountForm('pdfa1a', 'en', 'insert');
    const select = wrapper.getComponent(Select);
    select.vm.$emit('update:modelValue', 'letter');
    await flushPromises();
    select.vm.$emit('update:modelValue', 'custom');
    await flushPromises();
    expect(wrapper.props('parameter')).toMatchObject({ insertPageSize: 'custom', insertWidth: '612', insertHeight: '792' });
    expect(wrapper.find('.dimension-row').exists()).toBe(true);
    await wrapper.setProps({ converting: true });
    expect(select.props('disabled')).toBe(true);
    wrapper.unmount();
  });
});
