// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';
import PageRangeInput from './PageRangeInput.vue';
import en from '@/i18n/locales/en.json';
import zh from '@/i18n/locales/zh-cn.json';

const wrappers: VueWrapper[] = [];
function mountInput(modelValue = '', locale = 'en', attrs: Record<string, string> = {}) {
  let wrapper: VueWrapper<InstanceType<typeof PageRangeInput>>;
  wrapper = mount(PageRangeInput, {
    attachTo: document.body,
    attrs,
    props: { modelValue, 'onUpdate:modelValue': (value) => wrapper.setProps({ modelValue: value }) },
    global: { plugins: [createI18n({ legacy: false, locale, flatJson: true, messages: { en: { ...en }, zh: { ...zh } } })] },
  });
  wrappers.push(wrapper);
  return wrapper;
}
afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.unmount()); });

describe('page range dropdown', () => {
  it('selects All and then focuses an empty input for custom pages', async () => {
    const wrapper = mountInput('1,3-5');
    const input = wrapper.get('input');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.props('modelValue')).toBe('all');
    expect((input.element as HTMLInputElement).value).toBe('All Pages');
    await input.trigger('keydown', { key: 'ArrowUp' });
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.props('modelValue')).toBe('');
    expect((input.element as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(input.element);
    await input.setValue('1、3-5');
    expect(wrapper.props('modelValue')).toBe('1、3-5');
  });

  it('preserves raw custom input for the existing validation and keeps clearing editable', async () => {
    const wrapper = mountInput();
    const input = wrapper.get('input');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await input.setValue('5-1');
    expect(wrapper.props('modelValue')).toBe('5-1');
    await input.setValue('');
    expect((input.element as HTMLInputElement).value).toBe('');
    await wrapper.setProps({ modelValue: 'all' });
    expect((input.element as HTMLInputElement).value).toBe('All Pages');
    await wrapper.setProps({ modelValue: '2-4' });
    expect((input.element as HTMLInputElement).value).toBe('2-4');
  });

  it('renders both options and selects with the pointer without submitting a form', async () => {
    const wrapper = mountInput('all');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map((option) => option.textContent)).toEqual(['All Pages', 'Custom Pagese.g. 1,3-5,8']);
    (options[1] as HTMLElement).click();
    await flushPromises();
    expect(wrapper.props('modelValue')).toBe('');
    expect(wrapper.get('input').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('button').attributes('type')).toBe('button');
  });

  it('closes for Escape, Tab, and disabled changes, preserving error attributes on the input', async () => {
    const wrapper = mountInput('5-1', 'en', { 'aria-invalid': 'true', 'aria-describedby': 'range-error' });
    const input = wrapper.get('input');
    for (const key of ['Escape', 'Tab']) {
      await input.trigger('keydown', { key: 'ArrowDown' });
      expect(input.attributes('aria-expanded')).toBe('true');
      await input.trigger('keydown', { key });
      expect(input.attributes('aria-expanded')).toBe('false');
    }
    await input.trigger('keydown', { key: 'ArrowDown' });
    await wrapper.setProps({ disabled: true });
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(input.attributes('aria-describedby')).toBe('range-error');
    expect(input.attributes('disabled')).toBeDefined();
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(wrapper.props('modelValue')).toBe('5-1');
  });

  it('localizes the All label while emitting the API value all', async () => {
    const wrapper = mountInput('2', 'zh');
    await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' });
    await wrapper.get('input').trigger('keydown', { key: 'Enter' });
    expect(wrapper.props('modelValue')).toBe('all');
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe(zh['batchTools.stamp.allPages']);
  });
});
