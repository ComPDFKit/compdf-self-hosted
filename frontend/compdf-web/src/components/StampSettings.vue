<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { STAMP_POSITIONS, stampValidationKey, type StampKind, type StampMargin, type StampParameter } from '@/config/stamp-schema';
import { parsePages } from '@/utils/batch-files';
import WatermarkColorPicker from './WatermarkColorPicker.vue';
import PageNumberIcon from '@/assets/icons/ui/stamp-page-number.svg?component';
import DateIcon from '@/assets/icons/ui/stamp-date.svg?component';

const props = defineProps<{ kind: StampKind; disabled?: boolean }>();
const parameter = defineModel<StampParameter>('modelValue', { required: true });
const { t } = useI18n();
const id = useId();
const contentInput = ref<HTMLTextAreaElement | null>(null);
const edited = ref(false);
const pageNumberFormat = ref('<<1>>');
const dateFormat = ref('YYYY-MM-DD');
const dateFormats = ['YYYY-MM-DD', 'YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];
const margins: { side: StampMargin; key: string }[] = [
  { side: 'top', key: 'batchTools.stamp.marginTop' },
  { side: 'bottom', key: 'batchTools.stamp.marginBottom' },
  { side: 'left', key: 'batchTools.stamp.marginLeft' },
  { side: 'right', key: 'batchTools.stamp.marginRight' },
];
const isHeaders = computed(() => props.kind === 'headers-footers');
const errorKey = computed(() => stampValidationKey(props.kind, parameter.value));
const hasPageNumber = computed(() => STAMP_POSITIONS.some((position) => parameter.value.regions[position].includes('<<1>>')));

function update(patch: Partial<StampParameter>) {
  if (props.disabled) return;
  // Color and alpha can emit in one tick; keep the shared model current before
  // emitting so the second patch cannot overwrite the first with stale props.
  Object.assign(parameter.value, patch);
  parameter.value = { ...parameter.value };
  edited.value = true;
}
function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}
const content = computed({
  get: () => parameter.value.regions[parameter.value.position],
  set: (value: string) => update({ regions: { ...parameter.value.regions, [parameter.value.position]: value } }),
});
const pageRangeInput = computed({
  get: () => parameter.value.customPages,
  set: (value: string) => update({ customPages: value, pageRange: value.trim() && value.trim().toLowerCase() !== 'all' ? 'custom' : 'all' }),
});
const color = computed({ get: () => parameter.value.textColor, set: (value: string) => update({ textColor: value }) });
const opacity = computed({ get: () => String(parameter.value.textOpacity), set: (value: string) => update({ textOpacity: value }) });
const contentLabel = computed(() => t('batchTools.stamp.regionContent', { position: t(`batchTools.stamp.headerPositions.${parameter.value.position}`) }));
const processedPages = computed(() => parameter.value.pageRange === 'custom' ? parsePages(parameter.value.customPages)?.length : undefined);
function batesNumber(number: number): string {
  const digits = Number(parameter.value.digits);
  if (!Number.isSafeInteger(number) || number < 1 || !Number.isInteger(digits) || digits < 1 || digits > 32 || String(number).length > digits) return '—';
  return `${parameter.value.prefix}${String(number).padStart(digits, '0')}${parameter.value.suffix}`;
}
const firstNumber = computed(() => batesNumber(Number(parameter.value.startNumber)));
const lastNumber = computed(() => processedPages.value ? batesNumber(Number(parameter.value.startNumber) + processedPages.value - 1) : '—');
function updateMargin(side: StampMargin, event: Event) { update({ marginMm: { ...parameter.value.marginMm, [side]: inputValue(event) } }); }
async function insertText(text: string) {
  if (props.disabled) return;
  const start = contentInput.value?.selectionStart ?? content.value.length;
  const end = contentInput.value?.selectionEnd ?? start;
  content.value = content.value.slice(0, start) + text + content.value.slice(end);
  await nextTick();
  if (props.disabled) return;
  contentInput.value?.focus();
  contentInput.value?.setSelectionRange(start + text.length, start + text.length);
}
function insertDate() {
  const now = new Date();
  void insertText(dateFormat.value.replace('YYYY', String(now.getFullYear())).replace('MM', String(now.getMonth() + 1).padStart(2, '0')).replace('DD', String(now.getDate()).padStart(2, '0')));
}
</script>

<template>
  <section class="stamp-settings" :class="{ 'header-settings': isHeaders }">
    <fieldset class="settings-fieldset" :disabled="disabled">
      <legend class="settings-title">{{ t(isHeaders ? 'batchTools.stamp.headersTitle' : 'batchTools.stamp.batesTitle') }}</legend>
      <div class="settings-body">
        <label class="field">
          <span>{{ t('batchTools.stamp.pageRange') }}</span>
          <input v-model="pageRangeInput" class="text-input" type="text" :placeholder="t('batchTools.stamp.allPages')" :aria-invalid="errorKey === 'batchTools.stamp.errors.pages'">
        </label>

        <template v-if="isHeaders">
          <div class="pair-row">
            <label class="field"><span>{{ t('batchTools.stamp.pageNumberFormat') }}</span>
              <select v-model="pageNumberFormat" class="text-input"><option value="<<1>>">{{ t('batchTools.stamp.pageNumberPlain') }}</option><option value="Page <<1>>">{{ t('batchTools.stamp.pageNumberLabel') }}</option></select>
            </label>
            <label class="field"><span>{{ t('batchTools.stamp.pageOffset') }}</span><input class="text-input" type="number" min="1" max="2147483647" step="1" :value="parameter.pageOffset" :disabled="disabled || !hasPageNumber" @input="update({ pageOffset: inputValue($event) })"></label>
          </div>
          <label class="field"><span>{{ t('batchTools.stamp.dateFormat') }}</span><select v-model="dateFormat" class="text-input"><option v-for="format in dateFormats" :key="format" :value="format">{{ format }}</option></select></label>
        </template>

        <template v-else>
          <fieldset class="control-group">
            <legend>{{ t('batchTools.stamp.position') }}</legend>
            <div class="position-grid">
              <button v-for="position in STAMP_POSITIONS" :key="position" type="button" :class="{ selected: parameter.position === position }" :aria-pressed="parameter.position === position" @click="update({ position })">{{ t(`batchTools.stamp.positions.${position}`) }}</button>
            </div>
          </fieldset>
          <div class="bates-numbering tinted-group">
            <div class="pair-row">
              <label class="field"><span>{{ t('batchTools.stamp.prefix') }}</span><input class="text-input" type="text" maxlength="32" placeholder="CASE-" :value="parameter.prefix" @input="update({ prefix: inputValue($event) })"></label>
              <label class="field"><span>{{ t('batchTools.stamp.startNumber') }}</span><input class="text-input" type="number" min="1" max="2147483647" step="1" :value="parameter.startNumber" @input="update({ startNumber: inputValue($event) })"></label>
            </div>
            <div class="pair-row">
              <label class="field"><span>{{ t('batchTools.stamp.digits') }}</span><select class="text-input" :value="parameter.digits" @change="update({ digits: inputValue($event) })"><option v-for="digits in 32" :key="digits" :value="digits">{{ digits }}</option></select></label>
              <label class="field"><span>{{ t('batchTools.stamp.suffix') }}</span><input class="text-input" type="text" maxlength="32" placeholder="-A" :value="parameter.suffix" @input="update({ suffix: inputValue($event) })"></label>
            </div>
            <div class="number-examples" :class="{ 'has-final': processedPages }" aria-live="polite"><span>{{ t('batchTools.stamp.example') }}</span><output :title="firstNumber">{{ firstNumber }}</output><template v-if="processedPages"><span>{{ t('batchTools.stamp.finalNumber') }}</span><output :title="lastNumber">{{ lastNumber }}</output></template></div>
            <p class="numbering-note" :title="t('batchTools.stamp.backendLimit')">{{ t('batchTools.stamp.perFile') }}</p>
          </div>
        </template>

        <div class="pair-row">
          <label class="field"><span>{{ t('batchTools.stamp.font') }}</span><select class="text-input" :value="parameter.fontName" @change="update({ fontName: inputValue($event) })"><option value="Helvetica">Helvetica</option></select></label>
          <label class="field"><span>{{ t('batchTools.stamp.fontSize') }}</span><div class="unit-input"><input type="number" min="1" max="100" step="1" :value="parameter.fontSize" @input="update({ fontSize: inputValue($event) })"><span>pt</span></div></label>
        </div>
        <div class="pair-row">
          <div class="field"><span>{{ t('batchTools.stamp.color') }}</span><WatermarkColorPicker v-model="color" v-model:opacity="opacity" :disabled="disabled" /></div>
          <label class="field"><span>{{ t('pdfToolDetail.upload.settings.opacity') }}</span><input class="text-input" type="number" min="0" max="1" step="0.01" v-model="opacity"></label>
        </div>
        <div class="margin-grid">
          <label v-for="margin in margins" :key="margin.side" class="field"><span>{{ t(margin.key) }}</span><div class="unit-input"><input type="number" min="0" step="any" :value="parameter.marginMm[margin.side]" @input="updateMargin(margin.side, $event)"><span>mm</span></div></label>
        </div>

        <div v-if="isHeaders" class="header-content tinted-group">
          <fieldset class="control-group">
            <legend>{{ t('batchTools.stamp.position') }}</legend>
            <div class="position-grid">
              <button v-for="position in STAMP_POSITIONS" :key="position" type="button" :class="{ selected: parameter.position === position, populated: parameter.regions[position].trim() }" :aria-pressed="parameter.position === position" @click="update({ position })">{{ t(`batchTools.stamp.headerPositions.${position}`) }}</button>
            </div>
          </fieldset>
          <div class="content-toolbar">
            <label :for="`${id}-content`">{{ contentLabel }}</label>
            <div class="insert-actions">
              <button type="button" @click="insertText(pageNumberFormat)"><PageNumberIcon />{{ t('batchTools.stamp.insertPageNumber') }}</button>
              <button type="button" :title="t('batchTools.stamp.dateLiteralHelp')" @click="insertDate"><DateIcon />{{ t('batchTools.stamp.insertDate') }}</button>
            </div>
          </div>
          <textarea :id="`${id}-content`" ref="contentInput" v-model="content" rows="1" :placeholder="t('pdfToolDetail.upload.settings.pleaseEnter')" />
        </div>
        <p v-if="edited && errorKey" class="error-message" role="alert">{{ t(errorKey) }}</p>
      </div>
    </fieldset>
  </section>
</template>

<style scoped>
.stamp-settings { min-width: 0; color: #0c131f; font-size: 14px; line-height: 22px; }
.stamp-settings * { box-sizing: border-box; }
.settings-fieldset, .control-group { min-width: 0; margin: 0; padding: 0; border: 0; }
.settings-title { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.settings-body { display: flex; flex-direction: column; gap: 20px; }
.field { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pair-row, .margin-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.margin-grid { row-gap: 20px; }
.text-input, textarea { display: block; width: 100%; height: 32px; min-width: 0; padding: 4px 8px; border: 1px solid #dcdde1; border-radius: 3px; background: #fff; color: inherit; font: inherit; }
textarea { resize: vertical; min-height: 32px; max-height: 140px; }
.text-input::placeholder, textarea::placeholder { color: #9da1a9; }
.unit-input { display: flex; align-items: center; gap: 4px; height: 32px; border: 1px solid #dcdde1; border-radius: 3px; padding: 4px 8px; background: #fff; }
.unit-input input { min-width: 0; width: 100%; height: 22px; border: 0; padding: 0; outline: none; font: inherit; background: transparent; }
.unit-input>span { font-size: 12px; color: #979ca5; }
.unit-input:focus-within { border-color: #396ffa; }
.control-group>legend { padding: 0; margin: 0 0 8px; }
.position-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.position-grid button { position: relative; min-width: 0; min-height: 32px; padding: 4px; border: 1px solid #dcdde1; border-radius: 3px; background: #fff; font: inherit; font-size: 12px; color: inherit; overflow-wrap: anywhere; cursor: pointer; }
.position-grid button.selected { border-color: #618cfb; color: #396ffa; background: #f3f3f4; }
.position-grid button.populated::after { position: absolute; right: 3px; top: 3px; width: 4px; height: 4px; border-radius: 50%; background: #396ffa; content: ''; }
.tinted-group { padding: 12px; border-radius: 6px; background: #f5f7ff; }
.bates-numbering { display: flex; flex-direction: column; gap: 16px; }
.number-examples { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 4px 8px; padding: 4px 8px; background: #fff; color: #969ca6; font-size: 12px; }
.number-examples.has-final { grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr); }
.number-examples output { min-width: 0; max-width: 100%; padding: 0 4px; border: 1px solid #dcdde1; border-radius: 3px; background: #fff; color: #0c131f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.numbering-note { margin: -8px 0 0; color: #969ca6; font-size: 12px; }
.header-content { display: flex; flex-direction: column; gap: 16px; }
.content-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; }
.content-toolbar>label { font-size: 12px; }
.insert-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.insert-actions button { display: flex; align-items: center; gap: 4px; padding: 0; border: 0; background: transparent; color: #396ffa; font: inherit; font-size: 12px; cursor: pointer; }
.insert-actions svg { width: 14px; height: 14px; flex: none; }
.header-content textarea { margin-top: -8px; }
.error-message { margin: 0; color: #d44040; font-size: 12px; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid #396ffa; outline-offset: 2px; }
input:disabled, select:disabled, textarea:disabled, button:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 575px) { .pair-row, .margin-grid { gap: 12px; } }
</style>
