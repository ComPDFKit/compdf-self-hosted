// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';
import SplitSettings from './SplitSettings.vue';
import en from '@/i18n/locales/en.json';

function mountSettings() {
  let wrapper: VueWrapper<InstanceType<typeof SplitSettings>>;
  wrapper = mount(SplitSettings, {
    props: { mode: 'custom', ranges: '', count: 1, separator: '_', filename: 'Case.pdf',
      'onUpdate:mode': (mode) => wrapper.setProps({ mode }), 'onUpdate:ranges': (ranges) => wrapper.setProps({ ranges }),
      'onUpdate:count': (count) => wrapper.setProps({ count }), 'onUpdate:separator': (separator) => wrapper.setProps({ separator }),
    },
    global: { plugins: [createI18n({ legacy: false, locale: 'en', flatJson: true, messages: { en: { ...en } } })] },
  });
  return wrapper;
}

describe('Split settings variants', () => {
  it('estimates custom output ranges from user-entered groups and updates the filename example', async () => {
    const wrapper = mountSettings();
    expect(wrapper.find('.split-estimate').exists()).toBe(false);
    await wrapper.get('input[type="text"]').setValue('1-3,4-6,7-12');
    expect(wrapper.get('.split-estimate').text()).toBe('Estimated to split into 3 files');
    await wrapper.get('input[type="text"]').setValue('1-');
    expect(wrapper.find('.split-estimate').exists()).toBe(false);
    await wrapper.get('.separator-field select').setValue(' ');
    expect(wrapper.get('.split-filename').text()).toBe('Example: Case 1.pdf');
    await wrapper.setProps({ filename: 'Other.PDF' });
    expect(wrapper.get('.split-filename').text()).toBe('Example: Other 1.pdf');
    wrapper.unmount();
  });

  it('uses bounded numeric steppers and distinct sentences for every-N and equal splits', async () => {
    const wrapper = mountSettings();
    await wrapper.get('select').setValue('every');
    expect(wrapper.get('.split-quantity').text()).toContain('Split into one PDF file every');
    expect(wrapper.get('button[aria-label="Decrease"]').attributes('disabled')).toBeDefined();
    await wrapper.get('input[type="number"]').setValue('5');
    expect(wrapper.find('.split-estimate').exists()).toBe(false);
    await wrapper.get('button[aria-label="Increase"]').trigger('click');
    expect(wrapper.props('count')).toBe(6);
    expect(wrapper.find('.split-estimate').exists()).toBe(false);
    await wrapper.get('select').setValue('equal');
    expect(wrapper.get('.split-quantity').text()).toContain('Split evenly into');
    expect(wrapper.get('.split-estimate').text()).toBe('Estimated to split into 6 files');
    await wrapper.get('input[type="number"]').setValue('0');
    expect(wrapper.find('.split-estimate').exists()).toBe(false);
    await wrapper.setProps({ disabled: true });
    expect(wrapper.findAll('button,input,select').every((element) => element.attributes('disabled') !== undefined)).toBe(true);
    wrapper.unmount();
  });
});
