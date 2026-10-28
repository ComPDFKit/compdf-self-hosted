<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UploadParameter } from '@/config/param-schema';
import WatermarkColorPicker from './WatermarkColorPicker.vue';

defineProps<{ disabled?: boolean }>();
const parameter = defineModel<UploadParameter>('parameter', { required: true });
const imageFile = defineModel<File | null>('imageFile', { default: null });
const emit = defineEmits<{ (e: 'pick-image'): void }>();
const { t } = useI18n();
const id = useId();
const label = (key: string) => t(`pdfToolDetail.upload.settings.${key}`).replace(/[:：]\s*$/, '');
</script>

<template>
  <div class="watermark-settings">
    <label class="watermark-field">{{ label('pageRange') }}
      <input v-model="parameter.pageRanges" type="text" :disabled="disabled" :aria-label="label('pageRange')"
        :placeholder="t('batchTools.stamp.allPages')">
    </label>
    <fieldset class="watermark-type" :disabled="disabled">
      <legend>{{ label('watermarkType') }}</legend>
      <label><input v-model="parameter.watermarkType" type="radio" :name="`${id}-type`" value="text">{{ label('text')
        }}</label>
      <label><input v-model="parameter.watermarkType" type="radio" :name="`${id}-type`" value="image">{{ label('image')
        }}</label>
    </fieldset>
    <template v-if="parameter.watermarkType === 'text'">
      <label class="watermark-field">{{ label('watermarkText') }}<input v-model="parameter.watermarkText" type="text"
          :disabled="disabled" :placeholder="t('pdfToolDetail.upload.settings.pleaseEnter')"></label>
      <label class="watermark-field">{{ label('fontSize') }}<input v-model="parameter.watermarkFontSize" type="number"
          min="1" :disabled="disabled" :placeholder="t('pdfToolDetail.upload.settings.pleaseEnter')"></label>
    </template>
    <div v-else class="watermark-field">
      <span>{{ label('watermarkImage') }}</span><button type="button" class="image-picker" :disabled="disabled"
        @click="emit('pick-image')">{{ label('selectImage') }}</button>
      <span v-if="imageFile" class="picked-image">{{ imageFile.name }}<button type="button" :disabled="disabled"
          :aria-label="t('batchTools.delete')" @click="imageFile = null">×</button></span>
    </div>
    <div class="watermark-pair">
      <div v-if="parameter.watermarkType === 'text'" class="watermark-field"><span>{{ label('fontColor') }}</span>
        <WatermarkColorPicker v-model="parameter.watermarkFontColor" v-model:opacity="parameter.watermarkOpacity"
          :disabled="disabled" />
      </div>
      <label class="watermark-field">{{ label('opacity') }}<input v-model="parameter.watermarkOpacity" type="number"
          min="0" max="1" step="0.01" :disabled="disabled"></label>
    </div>
    <label class="watermark-field">{{ label('rotation') }}<input v-model="parameter.watermarkRotation" type="number"
        :disabled="disabled"></label>
    <div class="watermark-pair">
      <label class="watermark-field">{{ label('horizontalAlignment') }}<select v-model="parameter.watermarkHorizalign"
          :disabled="disabled">
          <option v-for="value in ['left', 'center', 'right']" :key="value" :value="value">{{ label(value) }}</option>
        </select></label>
      <label class="watermark-field">{{ label('verticalAlignment') }}<select v-model="parameter.watermarkVertalign"
          :disabled="disabled">
          <option v-for="value in ['top', 'center', 'bottom']" :key="value" :value="value">{{ label(value) }}</option>
        </select></label>
    </div>
    <fieldset class="watermark-offset" :disabled="disabled">
      <legend>{{ label('offset') }}</legend>
      <div class="watermark-pair"><input v-model="parameter.watermarkHorizOffset" type="number"
          :aria-label="label('horizontal')"><input v-model="parameter.watermarkVertOffset" type="number"
          :aria-label="label('vertical')"></div>
    </fieldset>
    <label class="watermark-toggle">{{ label('tileWatermark') }}<span class="switch"><input
          v-model="parameter.watermarkFullScreen" type="checkbox" :disabled="disabled"><span /></span></label>
    <fieldset v-if="parameter.watermarkFullScreen" class="watermark-offset" :disabled="disabled">
      <legend>{{ label('tileSpacing') }}</legend>
      <div class="watermark-pair"><input v-model="parameter.watermarkHorizontalSpacing" type="number" min="0"
          :aria-label="label('horizontal')" :placeholder="label('horizontal')"><input
          v-model="parameter.watermarkVerticalSpacing" type="number" min="0" :aria-label="label('vertical')"
          :placeholder="label('vertical')"></div>
    </fieldset>
  </div>
</template>

<style scoped>
.watermark-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
  font-size: 14px;
  line-height: 22px;
}

.watermark-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.watermark-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

input:not([type=radio]):not([type=checkbox]),
select,
.image-picker {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 4px 8px;
  border: 1px solid #dcdde1;
  border-radius: 3px;
  background: #fff;
  color: #0c131f;
  font: inherit;
}

input::placeholder {
  color: #9da1a9;
}

input:focus-visible,
select:focus-visible,
button:focus-visible {
  outline: 2px solid #396ffa;
  outline-offset: 2px;
}

fieldset {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}

legend {
  padding: 0;
  margin-bottom: 8px;
}

.watermark-type label {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  margin-right: 16px;
}

input[type=radio] {
  accent-color: #396ffa;
  margin: 0;
}

.watermark-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 32px;
}

.switch {
  display: inline-flex;
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
}

.switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  z-index: 1;
  cursor: pointer;
}

.switch>span {
  position: absolute;
  inset: 0;
  background: #dcdde1;
  border-radius: 12px;
}

.switch>span::after {
  content: '';
  position: absolute;
  width: 15px;
  height: 15px;
  left: 2.5px;
  top: 2.5px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px #0002;
}

.switch input:checked+span {
  background: #396ffa;
}

.switch input:checked+span::after {
  left: 18.5px;
}

.switch input:focus-visible+span {
  outline: 2px solid #396ffa;
  outline-offset: 2px;
}

.image-picker {
  color: #396ffa;
  cursor: pointer;
}

.picked-image {
  display: flex;
  gap: 8px;
  justify-content: space-between;
  overflow-wrap: anywhere;
}

.picked-image button {
  border: 0;
  background: none;
  color: #396ffa;
  cursor: pointer;
}

input:disabled,
select:disabled,
button:disabled {
  opacity: .5;
  cursor: not-allowed;
}

@media (max-width: 575px) {
  .watermark-pair {
    gap: 12px;
  }
}
</style>
