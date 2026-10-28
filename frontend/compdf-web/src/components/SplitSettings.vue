<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { splitCustomRanges, type SplitMode } from '@/utils/batch-files';
import MinusIcon from '@/assets/icons/ui/split-minus.svg?component';
import PlusIcon from '@/assets/icons/ui/split-plus.svg?component';

const props = defineProps<{ disabled?: boolean; filename?: string }>();
const mode = defineModel<SplitMode>('mode', { required: true });
const ranges = defineModel<string>('ranges', { required: true });
const count = defineModel<number>('count', { required: true });
const separator = defineModel<string>('separator', { required: true });
const { t } = useI18n();
const id = useId();
const estimate = computed(() => {
  if (mode.value === 'equal') return Number.isSafeInteger(count.value) && count.value > 0 ? count.value : undefined;
  if (mode.value !== 'custom') return undefined;
  const groups = splitCustomRanges(ranges.value);
  return groups?.some((group) => group === 'all') ? undefined : groups?.length;
});
const filenameExample = computed(() => `${(props.filename ?? '').replace(/\.pdf$/i, '').replace(/[\\/]/g, '_')}${separator.value}1.pdf`);
const separators = [['_', 'underscore'], ['-', 'hyphen'], ['.', 'period'], [' ', 'space']] as const;
function step(delta: number) {
  if (props.disabled) return;
  const current = Number.isSafeInteger(count.value) ? count.value : 1;
  count.value = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, current + delta));
}
</script>

<template>
  <div class="split-settings">
    <div class="split-rule-group">
      <label class="split-field">{{ t('batchTools.splitMethod') }}
        <select v-model="mode" :disabled="disabled">
          <option value="custom">{{ t('batchTools.splitCustom') }}</option>
          <option value="every">{{ t('batchTools.splitEvery') }}</option>
          <option value="equal">{{ t('batchTools.splitEqual') }}</option>
        </select>
      </label>
      <div class="split-field">
        <label :for="`${id}-range`">{{ t('batchTools.splitRanges') }}</label>
        <input v-if="mode === 'custom'" :id="`${id}-range`" v-model="ranges" type="text" :disabled="disabled" placeholder="1-3,4-6,7-12" :title="t('batchTools.splitGroupsHelp')">
        <i18n-t v-else scope="global" :keypath="mode === 'every' ? 'batchTools.splitEverySentence' : 'batchTools.splitEqualSentence'" tag="div" class="split-quantity">
          <template #count>
            <span class="split-stepper">
              <button type="button" :disabled="disabled || count <= 1" :aria-label="t('batchTools.splitDecrease')" @click="step(-1)"><MinusIcon /></button>
              <input :id="`${id}-range`" v-model.number="count" type="number" min="1" step="1" :disabled="disabled" :aria-label="t('batchTools.splitCount')">
              <button type="button" :disabled="disabled || count >= Number.MAX_SAFE_INTEGER" :aria-label="t('batchTools.splitIncrease')" @click="step(1)"><PlusIcon /></button>
            </span>
          </template>
        </i18n-t>
        <p v-if="estimate !== undefined" class="split-estimate" aria-live="polite">{{ t('batchTools.splitEstimate', { count: estimate }) }}</p>
      </div>
    </div>
    <label class="split-field separator-field">{{ t('batchTools.splitSeparator') }}
      <select v-model="separator" :disabled="disabled"><option v-for="[value, key] in separators" :key="key" :value="value">{{ t(`batchTools.splitSeparators.${key}`) }}</option></select>
      <span v-if="filename" class="split-filename" :title="filenameExample">{{ t('batchTools.splitFilenameExample', { filename: filenameExample }) }}</span>
    </label>
  </div>
</template>

<style scoped>
.split-settings { display: flex; flex-direction: column; gap: 20px; font-size: 14px; line-height: 22px; }
.split-rule-group { display: flex; flex-direction: column; gap: 16px; padding: 12px; background: #f5f7ff; border-radius: 6px; }
.split-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
input, select { width: 100%; min-width: 0; box-sizing: border-box; height: 32px; padding: 4px 8px; border: 1px solid #dcdde1; border-radius: 3px; background: #fff; color: #0c131f; font: inherit; }
input::placeholder { color: #9da1a9; }
.split-quantity { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; font-size: 12px; line-height: 20px; }
.split-stepper { display: inline-flex; align-items: center; flex: 1; min-width: 130px; gap: 4px; }
.split-stepper button { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 32px; height: 32px; padding: 8px; border: 1px solid #dcdde1; border-radius: 3px; background: #fff; cursor: pointer; }
.split-stepper button svg { width: 16px; height: 16px; flex: none; }
.split-stepper input { flex: 1; font-size: 14px; appearance: textfield; }
.split-stepper input::-webkit-inner-spin-button { appearance: none; }
.split-estimate { margin: -4px 0 0; color: #396ffa; font-size: 12px; line-height: 20px; text-align: right; }
.split-filename { margin-top: -4px; color: #9da1a9; font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
button:disabled, input:disabled, select:disabled { cursor: not-allowed; opacity: .5; }
input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid #396ffa; outline-offset: 2px; }
</style>
