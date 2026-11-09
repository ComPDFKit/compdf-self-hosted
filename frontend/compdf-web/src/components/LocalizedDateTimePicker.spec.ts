// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import LocalizedDateTimePicker from './LocalizedDateTimePicker.vue';

const props = {
  modelValue: '',
  locale: 'en',
  placeholder: 'Select date and time',
  clearLabel: 'Clear',
  todayLabel: 'Today',
  previousMonthLabel: 'Previous month',
  nextMonthLabel: 'Next month',
  hourLabel: 'Hour',
  minuteLabel: 'Minute',
};

describe('LocalizedDateTimePicker', () => {
  it('uses translated labels instead of the browser native datetime picker', async () => {
    const wrapper = mount(LocalizedDateTimePicker, { props });
    expect(wrapper.text()).toContain('Select date and time');
    await wrapper.find('button').trigger('click');
    expect(wrapper.find('button[aria-label="Previous month"]').exists()).toBe(true);
    expect(wrapper.find('button[aria-label="Next month"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Hour');
    expect(wrapper.text()).toContain('Minute');
    expect(wrapper.text()).toContain('Clear');
    expect(wrapper.text()).toContain('Today');
  });

  it('emits a local date-time value when a calendar day is selected', async () => {
    const wrapper = mount(LocalizedDateTimePicker, { props: { ...props, modelValue: '2026-11-02T13:37' } });
    await wrapper.find('button').trigger('click');
    const dayButtons = wrapper.findAll('button').filter((button) => /^\d+$/.test(button.text()));
    await dayButtons[0]?.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatch(/^2026-11-\d{2}T13:37$/);
  });

  it('supports clearing the selected value', async () => {
    const wrapper = mount(LocalizedDateTimePicker, { props: { ...props, modelValue: '2026-11-02T13:37' } });
    await wrapper.find('button').trigger('click');
    const clearButton = wrapper.findAll('button').find((button) => button.text() === 'Clear');
    await clearButton?.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('');
  });

  it('keeps internal clicks open and closes when clicking outside without changing the value', async () => {
    const wrapper = mount(LocalizedDateTimePicker, {
      props: { ...props, modelValue: '2026-11-02T13:37' },
      attachTo: document.body,
    });
    try {
      await wrapper.get('button').trigger('click');
      await wrapper.get('button[aria-label="Next month"]').trigger('click');
      expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');

      await new Promise((resolve) => setTimeout(resolve, 0));
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await nextTick();

      expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');
      expect(wrapper.find('select').exists()).toBe(false);
      expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    } finally {
      wrapper.unmount();
    }
  });

  it('closes the first picker when opening another picker', async () => {
    const first = mount(LocalizedDateTimePicker, { props, attachTo: document.body });
    const second = mount(LocalizedDateTimePicker, { props, attachTo: document.body });
    try {
      await first.get('button').trigger('click');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await second.get('button').trigger('pointerdown');
      await second.get('button').trigger('click', { detail: 1 });

      expect(first.get('button').attributes('aria-expanded')).toBe('false');
      expect(second.get('button').attributes('aria-expanded')).toBe('true');
    } finally {
      first.unmount();
      second.unmount();
    }
  });
});
