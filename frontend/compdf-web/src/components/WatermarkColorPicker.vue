<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent,
  ColorAreaRoot, ColorAreaArea, ColorAreaThumb,
  ColorSliderRoot, ColorSliderTrack, ColorSliderThumb,
  colorToHex, colorToString, convertToHsb, parseColor, type Color,
} from 'reka-ui';

const props = defineProps<{ disabled?: boolean }>();
const value = defineModel<string>({ required: true });
const opacity = defineModel<string>('opacity', { required: true });
const { t } = useI18n();
const open = ref(false);
const format = ref<'hex' | 'rgb' | 'hsl'>('rgb');
const color = ref<Color>(convertToHsb(parseColor('#000000')));
const draft = ref('');
const alpha = computed(() => Math.min(1, Math.max(0, Number(opacity.value) || 0)));
const opaqueHex = computed(() => colorToHex({ ...color.value, alpha: 1 }).toUpperCase());
const cssColor = computed(() => colorToString(color.value, 'rgb'));

function readColor(input: string): Color | null {
  try {
    const parsed = convertToHsb(parseColor(input));
    return Object.values(parsed).every((channel) => typeof channel !== 'number' || Number.isFinite(channel)) ? parsed : null;
  } catch { return null; }
}

watch([value, opacity], () => {
  const next = readColor(value.value || '#000000');
  if (next && colorToHex({ ...next, alpha: 1 }).toUpperCase() !== opaqueHex.value) color.value = { ...next, alpha: alpha.value };
  else color.value = { ...color.value, alpha: alpha.value };
}, { immediate: true });
watch([color, format], () => { draft.value = colorToString(color.value, format.value); }, { immediate: true, deep: true });
watch(() => props.disabled, (disabled) => { if (disabled) open.value = false; });

function updateColor(next: Color) {
  if (props.disabled) return;
  color.value = convertToHsb(next);
  // The SDK takes #RRGGBB and a separate opacity, never CSS or #RRGGBBAA.
  value.value = colorToHex({ ...next, alpha: 1 }).toUpperCase();
  opacity.value = String(Math.round(next.alpha * 100) / 100);
}
function commitDraft() {
  const next = readColor(draft.value);
  if (next) updateColor(next);
  else draft.value = colorToString(color.value, format.value);
}
function updateHex(event: Event) {
  if (props.disabled) return;
  const text = (event.target as HTMLInputElement).value;
  value.value = text;
  const next = readColor(text);
  if (next && /^#[\da-f]{6}$/i.test(text)) color.value = { ...next, alpha: alpha.value };
}
function updateOpacity(event: Event) {
  const next = Number((event.target as HTMLInputElement).value);
  if (!props.disabled && Number.isFinite(next) && next >= 0 && next <= 1) updateColor({ ...color.value, alpha: next });
}
</script>

<template>
  <div class="watermark-color-input">
    <input :value="value" type="text" spellcheck="false" :disabled="disabled" placeholder="#000000"
      :aria-label="t('batchTools.stamp.colorHex')" @input="updateHex">
    <PopoverRoot v-model:open="open">
      <PopoverTrigger as-child>
        <button type="button" class="color-button" :disabled="disabled" :aria-label="t('batchTools.stamp.colorPicker')">
          <span :style="{ backgroundColor: opaqueHex }" />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent class="watermark-color-popover" side="bottom" align="end" :side-offset="8" :collision-padding="12"
          :aria-label="t('batchTools.stamp.colorPicker')">
          <ColorAreaRoot v-slot="{ style }" :model-value="color" color-space="hsb" x-channel="saturation" y-channel="brightness"
            :disabled="disabled" @update:color="updateColor">
            <ColorAreaArea class="color-area" :style="style">
              <ColorAreaThumb class="color-thumb" :style="{ backgroundColor: opaqueHex }" :aria-label="t('batchTools.colorArea')" />
            </ColorAreaArea>
          </ColorAreaRoot>
          <div class="color-sliders-row">
            <div class="color-sliders">
              <ColorSliderRoot :model-value="color" channel="hue" color-space="hsb" class="color-slider" :disabled="disabled" @update:color="updateColor">
                <ColorSliderTrack class="color-track" /><ColorSliderThumb class="color-thumb" :aria-label="t('batchTools.colorHue')" :style="{ backgroundColor: opaqueHex }" />
              </ColorSliderRoot>
              <ColorSliderRoot :model-value="color" channel="alpha" class="color-slider" :disabled="disabled" @update:color="updateColor">
                <ColorSliderTrack class="color-track" /><ColorSliderThumb class="color-thumb" :aria-label="t('pdfToolDetail.upload.settings.opacity')" :style="{ backgroundColor: opaqueHex }" />
              </ColorSliderRoot>
            </div>
            <div class="color-swatch"><span :style="{ backgroundColor: cssColor }" /></div>
          </div>
          <div class="color-format-row">
            <select v-model="format" :aria-label="t('batchTools.colorFormat')" :disabled="disabled"><option value="rgb">CSS</option><option value="hex">HEX</option><option value="hsl">HSL</option></select>
            <input v-model="draft" type="text" :aria-label="t('pdfToolDetail.upload.settings.fontColor')" :disabled="disabled" @change="commitDraft" @keydown.enter.prevent="commitDraft">
            <input :value="opacity" type="number" min="0" max="1" step="0.01" :aria-label="t('pdfToolDetail.upload.settings.opacity')" :disabled="disabled" @input="updateOpacity">
          </div>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </div>
</template>

<style scoped>
.watermark-color-input { display: flex; align-items: center; width: 100%; height: 32px; min-width: 0; border: 1px solid #dcdde1; border-radius: 3px; background: #fff; padding: 4px 8px; gap: 8px; }
.watermark-color-input:focus-within { border-color: #396ffa; }
.watermark-color-input input { width: 100%; min-width: 0; border: 0; padding: 0; outline: none; font: inherit; background: transparent; }
.watermark-color-input input::placeholder { color: #9da1a9; }
.color-button { display: flex; padding: 0; border: 0; background: none; cursor: pointer; }
.color-button span { width: 16px; height: 16px; border-radius: 3px; }
:global(.watermark-color-popover) { z-index: 60; box-sizing: border-box; width: 256px; max-width: calc(100vw - 24px); padding: 12px; display: flex; flex-direction: column; gap: 12px; border: 1px solid #dcdde1; border-radius: 6px; background: #fff; color: #0c131f; font-size: 12px; box-shadow: 0 5px 5px -3px #0002, 0 8px 10px 1px #0001, 0 3px 14px 2px #0001; }
.color-area { position: relative; height: 168px; width: 100%; border-radius: 3px; overflow: hidden; touch-action: none; cursor: crosshair; }
.color-thumb { display: block; width: 18px; height: 18px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 1px 4px #0004; box-sizing: border-box; }
.color-sliders-row { display: flex; align-items: center; gap: 12px; }
.color-sliders { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 10px; }
.color-slider { position: relative; display: flex; align-items: center; height: 10px; width: 100%; touch-action: none; user-select: none; }
.color-track { position: relative; display: block; height: 8px; width: 100%; border-radius: 99px; }
.color-swatch { width: 28px; height: 28px; overflow: hidden; flex: none; border-radius: 3px; background: repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 0 0 / 8px 8px; }
.color-swatch span { display: block; width: 100%; height: 100%; }
.color-format-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 36px; gap: 6px; }
.color-format-row select, .color-format-row input { min-width: 0; width: 100%; box-sizing: border-box; height: 26px; padding: 2px 4px; background: #fff; border: 1px solid #dcdde1; border-radius: 3px; font: inherit; }
.color-format-row input[type=number] { appearance: textfield; }.color-format-row input::-webkit-inner-spin-button { appearance: none; }
button:focus-visible, .color-thumb:focus-visible { outline: 2px solid #396ffa; outline-offset: 2px; }
button:disabled, input:disabled, select:disabled { cursor: not-allowed; opacity: .5; }
</style>
