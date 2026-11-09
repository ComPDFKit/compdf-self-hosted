<script setup lang="ts">
import { computed, nextTick, ref, useAttrs, useId, watch, type StyleValue } from 'vue';
import { useI18n } from 'vue-i18n';
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  disabled?: boolean;
  size?: 'default' | 'compact' | 'form';
  inputClass?: string;
  placeholder?: string;
}>(), { size: 'default' });
const model = defineModel<string>({ default: '' });
const { t } = useI18n();
const attrs = useAttrs();
const id = useId();
const input = ref<HTMLInputElement>();
const anchor = ref<HTMLElement>();
const open = ref(false);
const active = ref(0);
const isAll = (value: string) => !value.trim() || value.trim().toLowerCase() === 'all';
const custom = ref(!isAll(model.value));
const displayValue = computed(() => !custom.value && model.value.trim() ? t('batchTools.stamp.allPages') : model.value);
const options = computed(() => [t('batchTools.stamp.allPages'), t('batchTools.stamp.customPages')]);
function inputAttrs() {
  const { class: _class, style: _style, ...rest } = attrs;
  return rest;
}
watch(model, (value) => {
  if (value.trim()) custom.value = !isAll(value);
});
watch(() => props.disabled, (disabled) => { if (disabled) open.value = false; });
function toggle() {
  if (props.disabled) return;
  active.value = custom.value ? 1 : 0;
  open.value = !open.value;
  input.value?.focus();
}
function edit(event: Event) {
  if (props.disabled) return;
  custom.value = true;
  model.value = (event.target as HTMLInputElement).value;
  open.value = false;
}
async function select(index: number) {
  if (props.disabled) return;
  custom.value = index === 1;
  model.value = custom.value ? (isAll(model.value) ? '' : model.value) : 'all';
  open.value = false;
  await nextTick();
  input.value?.focus();
  input.value?.select();
}
function keydown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    active.value = open.value ? (active.value + 1) % 2 : (event.key === 'ArrowDown' ? 0 : 1);
    open.value = true;
  } else if (event.key === 'Enter' && open.value) {
    event.preventDefault();
    void select(active.value);
  } else if (event.key === 'Escape' || event.key === 'Tab') {
    open.value = false;
  }
}
function interactOutside(event: Event) {
  const target = (event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent.target;
  if (target instanceof Node && anchor.value?.contains(target)) event.preventDefault();
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverAnchor as-child>
      <span ref="anchor" class="page-range-control" :class="[$attrs.class, `size-${size}`, { disabled }]" :style="$attrs.style as StyleValue">
        <input ref="input" v-bind="inputAttrs()" :class="['page-range-input', inputClass]" type="text"
          role="combobox" aria-autocomplete="none" aria-haspopup="listbox" :aria-expanded="open"
          :aria-controls="`${id}-options`" :aria-activedescendant="open ? `${id}-option-${active}` : undefined"
          :aria-label="($attrs['aria-label'] as string) || t('pdfToolDetail.upload.settings.pageRange')"
          :value="displayValue" :disabled="disabled" autocomplete="off"
          :placeholder="placeholder || t('batchTools.stamp.customPagesPlaceholder')"
          @input="edit" @keydown="keydown" @focus="!custom && input?.select()">
        <button type="button" class="page-range-toggle" :disabled="disabled" tabindex="-1"
          :aria-label="t('pdfToolDetail.upload.settings.pageRange')" :aria-expanded="open" :aria-controls="`${id}-options`"
          @mousedown.prevent @click.prevent="toggle">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </span>
    </PopoverAnchor>
    <PopoverPortal>
      <PopoverContent as-child align="start" :side-offset="4" :collision-padding="8"
        @open-auto-focus.prevent @close-auto-focus.prevent @interact-outside="interactOutside">
        <div :id="`${id}-options`" role="listbox" class="page-range-options" :aria-label="t('pdfToolDetail.upload.settings.pageRange')">
          <div v-for="(option, index) in options" :id="`${id}-option-${index}`" :key="index" role="option"
            :aria-selected="custom ? index === 1 : !!model.trim() && index === 0" class="page-range-option" :class="{ active: active === index }"
            @pointermove="active = index" @mousedown.prevent @click="select(index)">
            <span>{{ option }}</span><span v-if="index === 1" class="range-example">{{ placeholder || t('batchTools.stamp.customPagesPlaceholder') }}</span>
          </div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
.page-range-control { display: inline-flex; align-items: center; width: 100%; max-width: 100%; min-width: 0; height: 32px; box-sizing: border-box; border: 1px solid #dcdde1; border-radius: 3px; background: #fff; color: #0c131f; font-size: 14px; }
.page-range-control:focus-within { border-color: #396ffa; box-shadow: 0 0 0 2px rgba(57, 111, 250, .14); }
.page-range-control:has(input[aria-invalid="true"]) { border-color: #d44040; }
.page-range-input { flex: 1; width: 0; min-width: 0; height: 100%; border: 0; outline: none; border-radius: inherit; padding: 0 8px; background: transparent; color: inherit; font: inherit; }
.page-range-input::placeholder { color: #9da1a9; }
.page-range-toggle { display: flex; align-items: center; justify-content: center; flex: none; width: 30px; height: 100%; padding: 0; border: 0; background: transparent; color: #9298a3; cursor: pointer; }
.page-range-toggle svg { width: 16px; height: 16px; }
.page-range-control.disabled { background: #f5f5f5; color: #999; }
.page-range-control.disabled input, .page-range-toggle:disabled { cursor: not-allowed; }
.size-compact { height: 26px; font-size: 12px; }
.size-compact .page-range-toggle { width: 26px; }
.size-form { width: 100%; height: 40px; border-color: #c7cad1; border-radius: 8px; font-size: 16px; }
.size-form .page-range-input { padding-left: 14px; }
.page-range-options { z-index: 100; width: var(--reka-popover-trigger-width); min-width: 160px; max-width: calc(100vw - 16px); padding: 4px; box-sizing: border-box; border: 1px solid #dcdde1; border-radius: 4px; background: #fff; color: #0c131f; box-shadow: 0 4px 12px rgba(0, 0, 0, .12); font-size: 14px; outline: none; }
.page-range-option { display: flex; flex-wrap: wrap; gap: 2px 8px; padding: 7px 8px; border-radius: 2px; cursor: pointer; }
.page-range-option.active { background: #f0f3ff; color: #396ffa; }
.range-example { color: #8b919c; font-size: 12px; }
@media (max-width: 768px) { .size-form { width: 100%; } }
</style>
