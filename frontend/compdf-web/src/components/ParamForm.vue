<script setup lang="ts">
/**
 * ParamForm — the parameter-controls body.
 *
 * Uses native HTML controls and scoped CSS. Each block is gated by the matching
 * CONVERSION_FEATURES flag computed from `conversionKey = ${fromType}/${toType}`
 * with searchablePdf/img overrides.
 *
 * Element Plus → local control mapping:
 *   el-radio-group/el-radio → <input type="radio" :value v-model> grouped by name
 *   el-select/el-option     → shadcn-vue Select (reka-ui)
 *   el-switch (1/0 toggles) → <input type="checkbox" true-value="1" false-value="0">
 *   el-switch (boolean)     → <input type="checkbox">
 *   el-checkbox group       → individual <input type="checkbox"> bound to array membership
 *   el-tooltip              → CSS tooltip on a (?) marker
 *
 * File pickers (watermark image / insert target): UploadPanel owns the hidden
 * <input type=file> elements + the upload() FormData assembly. ParamForm EMITS
 * pick-watermark-image / pick-insert-target requests and receives the picked
 * File back as a v-model to render the filename + allow clearing. This keeps
 * the file refs where buildRequest consumes them (UploadPanel) and avoids
 * threading template refs across the component boundary.
 */
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { COMPRESS_PRESET_FLAGS, CONVERSION_FEATURES, type ConversionFeatures, type UploadParameter } from '@/config/param-schema';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import DeleteIcon from '@/assets/icons/ui/delete.svg?component';
import PdfIcon from '@/assets/icons/ui/pdf.svg?component';

const props = defineProps<{
  fromType: string;
  toType: string;
  files: File[];
  /** Disable all controls while a conversion is in flight. */
  converting?: boolean;
}>();

// Local form models. Picked files round-trip back here for
// filename display and clearing.
const parameter = defineModel<UploadParameter>('parameter', { required: true });
const password = defineModel<string>('password', { required: true });
const isCsvMerge = defineModel<string>('isCsvMerge', { required: true });
const watermarkImageFile = defineModel<File | null>('watermarkImageFile', { default: null });
const insertTargetFile = defineModel<File | null>('insertTargetFile', { default: null });

const emit = defineEmits<{
  (e: 'pick-watermark-image'): void;
  (e: 'pick-insert-target'): void;
  /** Per-file delete in the merge list — UploadPanel owns rawFiles, so it handles the splice. */
  (e: 'delete-merge-file', index: number): void;
  /** Single-file tools such as split use a parameter card with its own delete affordance. */
  (e: 'delete-file'): void;
}>();

const { t } = useI18n();

const converting = computed(() => props.converting ?? false);

// ---- conversionKey + features ---------------------------------------------
const isSearchablePdf = computed(() => props.fromType === 'pdf' && props.toType === 'searchablePdf');

/**
 * The current conversion key. Every tool in the self-hosted catalog has a fixed
 * toType, so merge uses toType='merge' -> 'pdf/merge'.
 */
const conversionKey = computed(() => {
  if (isSearchablePdf.value) return 'pdf/searchablePdf';
  if (props.fromType === 'img') return `img/${props.toType}`;
  return `${props.fromType}/${props.toType}`;
});

const features = computed<ConversionFeatures>(() => CONVERSION_FEATURES[conversionKey.value] || {});

// Template-friendly aliases.
const hasFlowLayout = computed(() => !!features.value.flowLayout);
const hasContainImg = computed(() => !!features.value.includeImages);
const hasContainAnnotation = computed(() => !!features.value.includeAnnotations);
const hasFormulaToImage = computed(() => !!features.value.formulaToImage);
const hasAllowOcr = computed(() => !!features.value.allowOcr);
const hasPageOneOutput = computed(() => !!features.value.pageOneOutput);
const hasRetainBgImg = computed(() => !!features.value.retainBgImg);
const hasImageFormat = computed(() => !!features.value.imageFormat);
const hasExcelOptions = computed(() => !!features.value.excelOptions);
const hasImgDpi = computed(() => !!features.value.imgDpi);
const hasPage = computed(() => !!features.value.pageRange);
const hasMergeCsv = computed(() => !!features.value.mergeCsv);
const hasHtmlOption = computed(() => !!features.value.htmlOption);
const hasJsonContent = computed(() => !!features.value.jsonContent);
const hasPassword = computed(() => !!features.value.password);
const hasTransparentText = computed(() => !!features.value.transparentText);
const hasOcrSettings = computed(() => !!features.value.ocrSettings);
const hasRotateAngle = computed(() => !!features.value.rotateAngle);
const hasInsertOptions = computed(() => !!features.value.insertOptions);
const hasWatermarkOptions = computed(() => !!features.value.watermarkOptions);
const hasEncryptOptions = computed(() => !!features.value.encryptOptions);
// These three gate on toType, not on a features flag.
const hasCompressOptions = computed(() => props.toType === 'compress');
const hasMergeOptions = computed(() => props.toType === 'merge');
const hasSplitOptions = computed(() => props.toType === 'split');

/** OCR-dependent disabled state: language/scope/bg switches grey out when OCR is off and not searchablePdf. */
const ocrDisabled = computed(() => converting.value || (!Number(parameter.value.enableOcr) && !isSearchablePdf.value));
const ocrLabelDim = computed(() => !Number(parameter.value.enableOcr) && !isSearchablePdf.value);

// ---- static option lists ---------------------------------------------------
const rotateAngles = [90, 180, 270];
const imageFormats = ['png', 'jpg', 'jpeg', 'jpeg2000', 'bmp', 'tiff', 'tga', 'gif', 'webp'];
const pageRangePlaceholder = computed(() => `all ${t('pdfToolDetail.upload.settings.pageRangeOr')} 1-3,5`);
const ocrLanguages = [
  'AUTO',
  'CHINESE',
  'CHINESE_TRAD',
  'ENGLISH',
  'KOREAN',
  'JAPANESE',
  'LATIN',
  'DEVANAGARI',
  'CYRILLIC',
  'ARABIC',
  'TAMIL',
  'TELUGU',
  'KANNADA',
  'THAI',
  'GREEK',
  'ESLAV',
];
const ocrOptions = ['ALL', 'SCAN_PAGE', 'INVALID_CHARACTER', 'INVALID_CHARACTER_AND_SCAN_PAGE'];

// compress flag groups + presets
const compressFlagGroups: Array<{ titleKey: string; items: Array<{ labelKey: string; flags: string[] }> }> = [
  {
    titleKey: 'pdfToolDetail.upload.settings.compressFontSettings',
    items: [{ labelKey: 'pdfToolDetail.upload.settings.removeEmbeddedFonts', flags: ['RMEMBFONT'] }],
  },
  {
    titleKey: 'pdfToolDetail.upload.settings.compressDiscardObjects',
    items: [
      { labelKey: 'pdfToolDetail.upload.settings.discardFormActions', flags: ['RMFORMCOMMITIMPORTRESETACTION'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardJsActions', flags: ['RMJSACTION'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardPageThumbnails', flags: ['RMPAGETHUMBNAIL'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardPageLabels', flags: ['RMLABEL'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardBookmarks', flags: ['RMBK'] },
    ],
  },
  {
    titleKey: 'pdfToolDetail.upload.settings.compressDiscardUserData',
    items: [
      { labelKey: 'pdfToolDetail.upload.settings.discardAnnotationsFormsMultimedia', flags: ['RMANNOT', 'RMFORM', 'RMMULMEDIA'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardDocInfoMetadata', flags: ['RMDOCINFO', 'RMMEDTADATA'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardObjectData', flags: ['RMOBJDATA'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardFileAttachments', flags: ['RMFILEATTACHMENT'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardHiddenLayers', flags: ['RMHIDERLAYER', 'MERGEVISIBLELAYER'] },
    ],
  },
  {
    titleKey: 'pdfToolDetail.upload.settings.compressDiscardOtherData',
    items: [
      { labelKey: 'pdfToolDetail.upload.settings.discardInvalidBookmarks', flags: ['RMINVABK'] },
      { labelKey: 'pdfToolDetail.upload.settings.discardInvalidLinks', flags: ['RMINVALINK'] },
    ],
  },
];

// The self-hosted UI does no per-file flow-layout analysis, so e_Flow stays
// enabled.
const forbidFlowLayout = computed(() => false);

// ---- compress flag handlers ------------------------------------------------
function isFlagChecked(flags: string[]): boolean {
  return flags.every((f) => (parameter.value.compressCustomFlags as string[]).includes(f));
}
function toggleFlagGroup(flags: string[], checked: boolean): void {
  const current = parameter.value.compressCustomFlags as string[];
  if (checked) {
    parameter.value.compressCustomFlags = [...new Set([...current, ...flags])];
  } else {
    parameter.value.compressCustomFlags = current.filter((f) => !flags.includes(f));
  }
}
function handleCompressQualityChange(value: unknown): void {
  const val = String(value);
  if (val === 'low') {
    parameter.value.compressCustomFlags = [...COMPRESS_PRESET_FLAGS.low];
    parameter.value.compressImageQuality = '30';
  } else if (val === 'medium') {
    parameter.value.compressCustomFlags = [...COMPRESS_PRESET_FLAGS.medium];
    parameter.value.compressImageQuality = '60';
  } else if (val === 'high') {
    parameter.value.compressCustomFlags = [...COMPRESS_PRESET_FLAGS.high];
    parameter.value.compressImageQuality = '80';
  }
}

// ---- file pickers: emit, let UploadPanel drive the hidden <input type=file> ----
function pickWatermarkImage() {
  emit('pick-watermark-image');
}
function pickInsertTarget() {
  emit('pick-insert-target');
}
function clearInsertTarget() {
  // UploadPanel clears the hidden input's value after each pick, so nulling the
  // model is enough to reset the UI + buildRequest's insertTargetFile.
  insertTargetFile.value = null;
}

function deleteMergeFile(index: number) {
  emit('delete-merge-file', index);
}
function deleteFile() {
  emit('delete-file');
}

// ---- parameter-internal invariants ----------------------------------------
// These mutate the shared parameter object (defineModel → propagates up to
// UploadPanel's ref).
watch(
  () => parameter.value,
  (val) => {
    if (!Number(val.enableOcr)) {
      val.containPageBackgroundImage = '0';
    } else if (isSearchablePdf.value) {
      val.containPageBackgroundImage = '1';
    }
    if (hasExcelOptions.value && Number(val.excelAllContent) && val.excelWorksheetOption === 'e_ForTable') {
      val.excelWorksheetOption = 'e_ForPage';
    }
  },
  { deep: true },
);
watch(
  () => parameter.value.isContainImg,
  (val) => {
    if (!Number(val) && Number(parameter.value.formulaToImage)) {
      parameter.value.formulaToImage = '0';
    }
  },
);
watch(
  () => parameter.value.formulaToImage,
  (val) => {
    if (Number(val) && !Number(parameter.value.isContainImg)) {
      parameter.value.isContainImg = '1';
    }
  },
);
watch(
  conversionKey,
  (key) => {
    if (key !== 'pdf/docx') return;
    if (parameter.value.pageLayoutMode === 'e_Flow') {
      parameter.value.pageLayoutMode = 'e_Box';
    }
    if (parameter.value.formulaToImage === '0') {
      parameter.value.formulaToImage = '1';
    }
  },
  { immediate: true },
);
// Lift enableOcr for image sources and searchable PDF tools. Runs on mount and
// when the flag flips.
watch(
  () => props.fromType === 'img' || isSearchablePdf.value,
  (val) => {
    if (val) {
      parameter.value.enableOcr = '1';
      if (isSearchablePdf.value) parameter.value.containPageBackgroundImage = '1';
    }
  },
  { immediate: true },
);
</script>

<template>
  <TooltipProvider :delay-duration="100">
  <div class="param-form" :class="{ 'file-card-form': hasSplitOptions || hasMergeOptions }">
    <!-- 1. HTML output option -->
    <div v-if="hasHtmlOption" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.htmlFileOptions') }}:</div>
      <div class="setting-control">
        <div class="radio-stack">
          <label><input type="radio" name="htmlOption" value="e_SinglePage" v-model="parameter.htmlOption" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.singleHtml') }}</label>
          <label><input type="radio" name="htmlOption" value="e_SinglePageWithBookmark" v-model="parameter.htmlOption" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.singleHtmlWithOutlines') }}</label>
          <label><input type="radio" name="htmlOption" value="e_MultiPage" v-model="parameter.htmlOption" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.multiHtml') }}</label>
          <label><input type="radio" name="htmlOption" value="e_MultiPageWithBookmark" v-model="parameter.htmlOption" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.multiHtmlWithOutlines') }}</label>
        </div>
      </div>
    </div>

    <!-- 2. JSON content scope -->
    <div v-if="hasJsonContent" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.includeContent') }}:</div>
      <div class="setting-control">
        <div class="radio-row">
          <label><input type="radio" name="jsonType" value="0" v-model="parameter.type" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.onlyText') }}</label>
          <label><input type="radio" name="jsonType" value="1" v-model="parameter.type" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.onlyTable') }}</label>
          <label><input type="radio" name="jsonType" value="2" v-model="parameter.type" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.allContent') }}</label>
        </div>
      </div>
    </div>

    <!-- 3. Layout mode (PDF → Word) -->
    <div v-if="hasFlowLayout" class="setting-row">
      <div class="setting-label">
        {{ t('pdfToolDetail.upload.settings.layoutSetting') }}<Tooltip>
          <TooltipTrigger as-child>
            <button type="button" class="tip" :aria-label="t('pdfToolDetail.upload.settings.layoutSettingTip')">?</button>
          </TooltipTrigger>
          <TooltipContent>{{ t('pdfToolDetail.upload.settings.layoutSettingTip') }}</TooltipContent>
        </Tooltip>:
      </div>
      <div class="setting-control">
        <div class="radio-row">
          <label><input type="radio" name="pageLayoutMode" value="e_Box" v-model="parameter.pageLayoutMode" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.fixedLayout') }}</label>
          <label><input type="radio" name="pageLayoutMode" value="e_Flow" v-model="parameter.pageLayoutMode" :disabled="forbidFlowLayout || converting"> {{ t('pdfToolDetail.upload.settings.hybridLayout') }}</label>
        </div>
      </div>
    </div>

    <!-- 4. Excel content scope -->
    <div v-if="hasExcelOptions" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.includeContent') }}:</div>
      <div class="setting-control">
        <div class="radio-row">
          <label><input type="radio" name="excelAllContent" value="0" v-model="parameter.excelAllContent" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.onlyTable') }}</label>
          <label><input type="radio" name="excelAllContent" value="1" v-model="parameter.excelAllContent" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.allContent') }}</label>
        </div>
      </div>
    </div>

    <!-- 5. Excel worksheet option -->
    <div v-if="hasExcelOptions" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.worksheetOptions') }}:</div>
      <div class="setting-control">
        <div class="radio-stack">
          <label><input type="radio" name="excelWorksheetOption" value="e_ForTable" v-model="parameter.excelWorksheetOption" :disabled="converting || parameter.excelAllContent === '1'"> {{ t('pdfToolDetail.upload.settings.forEachTable') }}</label>
          <label><input type="radio" name="excelWorksheetOption" value="e_ForPage" v-model="parameter.excelWorksheetOption" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.forEachPage') }}</label>
          <label><input type="radio" name="excelWorksheetOption" value="e_ForDocument" v-model="parameter.excelWorksheetOption" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.forEachDocument') }}</label>
        </div>
      </div>
    </div>

    <!-- 6. DPI -->
    <div v-if="hasImgDpi" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.dpiRange') }}:</div>
      <div class="setting-control">
        <input type="number" min="72" max="1500" placeholder="72~1500" v-model="parameter.imgDpi" :disabled="converting" class="num-input">
      </div>
    </div>

    <!-- 7. Page range -->
    <div v-if="hasPage && !hasSplitOptions" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.pageRange') }}:</div>
      <div class="setting-control">
        <input type="text" placeholder="1,2,3-5" v-model="parameter.pageRanges" :disabled="converting" class="text-input">
      </div>
    </div>

    <!-- 8. Rotate angle -->
    <div v-if="hasRotateAngle" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.angle') }}:</div>
      <div class="setting-control">
        <Select v-model="parameter.rotateAngle" :disabled="converting">
          <SelectTrigger class="select-input"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="a in rotateAngles" :key="a" :value="String(a)">{{ a }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <!-- 9-14. Insert options -->
    <template v-if="hasInsertOptions">
      <div class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.insertMode') }}:</div>
        <div class="setting-control">
          <div class="radio-row">
            <label><input type="radio" name="insertActionType" value="BLANK" v-model="parameter.insertActionType" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.blankPages') }}</label>
            <label><input type="radio" name="insertActionType" value="FROM_PDF" v-model="parameter.insertActionType" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.fromPdf') }}</label>
          </div>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.insertIndex') }}:</div>
        <div class="setting-control">
          <input type="number" min="0" v-model.number="parameter.insertIndex" :disabled="converting" class="num-input">
        </div>
      </div>
      <!-- 11. Blank page count -->
      <div v-if="parameter.insertActionType === 'BLANK'" class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.blankPageCount') }}:</div>
        <div class="setting-control">
          <input type="number" min="1" v-model.number="parameter.insertCount" :disabled="converting" class="num-input">
        </div>
      </div>
      <!-- 12. Blank page size -->
      <div v-if="parameter.insertActionType === 'BLANK'" class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.blankPageSize') }}:</div>
        <div class="setting-control">
          <div class="pair-row">
            <input type="number" min="1" v-model="parameter.insertWidth" :placeholder="t('pdfToolDetail.upload.settings.width')" :disabled="converting" class="num-input">
            <input type="number" min="1" v-model="parameter.insertHeight" :placeholder="t('pdfToolDetail.upload.settings.height')" :disabled="converting" class="num-input">
          </div>
        </div>
      </div>
      <!-- 13. Insert target file picker -->
      <template v-if="parameter.insertActionType === 'FROM_PDF'">
        <div class="setting-row">
          <div class="setting-label">{{ t('pdfToolDetail.upload.settings.insertTargetFile') }}:</div>
          <div class="setting-control">
            <div v-if="insertTargetFile" class="file-chip">
              <span class="file-chip-name">{{ insertTargetFile.name }}</span>
              <button type="button" class="file-chip-clear" :title="t('pdfToolDetail.upload.startOver')" @click="clearInsertTarget">×</button>
            </div>
            <button v-else type="button" class="pick-btn" :disabled="converting" @click="pickInsertTarget">{{ t('pdfToolDetail.upload.selectFile') }}</button>
          </div>
        </div>
        <!-- 14. Source PDF pages -->
        <div class="setting-row">
          <div class="setting-label">{{ t('pdfToolDetail.upload.settings.sourcePages') }}:</div>
          <div class="setting-control">
            <input type="text" placeholder="0-1,3-3" v-model="parameter.sourcePages" :disabled="converting" class="text-input">
          </div>
        </div>
        <!-- 15. Insert PDF password -->
        <div class="setting-row">
          <div class="setting-label">{{ t('pdfToolDetail.upload.settings.insertPassword') }}:</div>
          <div class="setting-control">
            <input type="text" v-model="parameter.insertTargetPassword" :disabled="converting" class="text-input">
          </div>
        </div>
      </template>
    </template>

    <!-- 15-17. Compress options -->
    <template v-if="hasCompressOptions">
      <div class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.compressQuality') }}:</div>
      <div class="setting-control">
          <Select v-model="parameter.compressQuality" :disabled="converting" @update:model-value="handleCompressQualityChange">
            <SelectTrigger class="select-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">{{ t('pdfToolDetail.upload.settings.lowQuality') }}</SelectItem>
              <SelectItem value="medium">{{ t('pdfToolDetail.upload.settings.mediumQuality') }}</SelectItem>
              <SelectItem value="high">{{ t('pdfToolDetail.upload.settings.highQuality') }}</SelectItem>
              <SelectItem value="custom">{{ t('pdfToolDetail.upload.settings.customQuality') }}</SelectItem>
            </SelectContent>
          </Select>
      </div>
    </div>
      <!-- 16. Custom flag groups -->
      <template v-if="parameter.compressQuality === 'custom'">
        <div v-for="group in compressFlagGroups" :key="group.titleKey" class="flag-group">
          <div class="flag-group-title">{{ t(group.titleKey) }}</div>
          <label v-for="item in group.items" :key="item.labelKey" class="flag-item">
            <input type="checkbox" :checked="isFlagChecked(item.flags)" :disabled="converting" @change="toggleFlagGroup(item.flags, ($event.target as HTMLInputElement).checked)">
            {{ t(item.labelKey) }}
          </label>
        </div>
        <!-- 17. Image quality -->
        <div class="setting-row">
          <div class="setting-label">{{ t('pdfToolDetail.upload.settings.imageQuality') }}:</div>
          <div class="setting-control">
            <input type="number" min="0" max="100" v-model="parameter.compressImageQuality" :disabled="converting" class="num-input">
          </div>
        </div>
      </template>
    </template>

    <!-- 18-28. Watermark options -->
    <template v-if="hasWatermarkOptions">
      <div class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.watermarkType') }}:</div>
        <div class="setting-control">
          <div class="radio-row">
            <label><input type="radio" name="watermarkType" value="text" v-model="parameter.watermarkType" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.text') }}</label>
            <label><input type="radio" name="watermarkType" value="image" v-model="parameter.watermarkType" :disabled="converting"> {{ t('pdfToolDetail.upload.settings.image') }}</label>
          </div>
        </div>
      </div>
      <!-- 19. Watermark image picker -->
      <div v-if="parameter.watermarkType === 'image'" class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.watermarkImage') }}:</div>
        <div class="setting-control">
          <button type="button" class="pick-btn" :disabled="converting" @click="pickWatermarkImage">{{ t('pdfToolDetail.upload.settings.selectImage') }}</button>
          <div v-if="watermarkImageFile" class="file-name">{{ watermarkImageFile.name }}</div>
        </div>
      </div>
      <!-- 20. Watermark text -->
      <div v-if="parameter.watermarkType === 'text'" class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.watermarkText') }}:</div>
        <div class="setting-control">
          <input type="text" v-model="parameter.watermarkText" :disabled="converting" class="text-input">
        </div>
      </div>
      <!-- 21. Watermark font size + color -->
      <div v-if="parameter.watermarkType === 'text'" class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.font') }}:</div>
        <div class="setting-control">
          <div class="pair-row">
            <input type="number" min="1" v-model="parameter.watermarkFontSize" :placeholder="t('pdfToolDetail.upload.settings.size')" :disabled="converting" class="num-input">
            <input type="text" v-model="parameter.watermarkFontColor" placeholder="#D32F2F" :disabled="converting" class="text-input">
          </div>
        </div>
      </div>
      <!-- 22. Opacity -->
      <div class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.opacity') }}:</div>
        <div class="setting-control">
          <input type="number" min="0" max="1" step="0.1" placeholder="0.1~1" v-model.number="parameter.watermarkOpacity" :disabled="converting" class="num-input">
        </div>
      </div>
      <!-- 23. Rotation -->
      <div class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.rotation') }}:</div>
        <div class="setting-control">
          <input type="number" v-model="parameter.watermarkRotation" :disabled="converting" class="num-input">
        </div>
      </div>
      <!-- 24. Horizontal alignment -->
      <div class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.horizontalAlignment') }}:</div>
      <div class="setting-control">
          <Select v-model="parameter.watermarkHorizalign" :disabled="converting">
            <SelectTrigger class="select-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="left">{{ t('pdfToolDetail.upload.settings.left') }}</SelectItem>
              <SelectItem value="center">{{ t('pdfToolDetail.upload.settings.center') }}</SelectItem>
              <SelectItem value="right">{{ t('pdfToolDetail.upload.settings.right') }}</SelectItem>
            </SelectContent>
          </Select>
      </div>
    </div>
      <!-- 25. Vertical alignment -->
      <div class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.verticalAlignment') }}:</div>
      <div class="setting-control">
          <Select v-model="parameter.watermarkVertalign" :disabled="converting">
            <SelectTrigger class="select-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="top">{{ t('pdfToolDetail.upload.settings.top') }}</SelectItem>
              <SelectItem value="center">{{ t('pdfToolDetail.upload.settings.center') }}</SelectItem>
              <SelectItem value="bottom">{{ t('pdfToolDetail.upload.settings.bottom') }}</SelectItem>
            </SelectContent>
          </Select>
      </div>
    </div>
      <!-- 26. Offset -->
      <div class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.offset') }}:</div>
        <div class="setting-control">
          <div class="pair-row">
            <input type="number" v-model="parameter.watermarkHorizOffset" :placeholder="t('pdfToolDetail.upload.settings.horizontal')" :disabled="converting" class="num-input">
            <input type="number" v-model="parameter.watermarkVertOffset" :placeholder="t('pdfToolDetail.upload.settings.vertical')" :disabled="converting" class="num-input">
          </div>
        </div>
      </div>
      <!-- 27. Tile watermark -->
      <div class="setting-row-switch">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.tileWatermark') }}:</div>
        <label class="switch"><input type="checkbox" v-model="parameter.watermarkFullScreen" :disabled="converting"><span class="track"></span></label>
      </div>
      <!-- 28. Tile spacing -->
      <div v-if="parameter.watermarkFullScreen" class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.tileSpacing') }}:</div>
        <div class="setting-control">
          <div class="pair-row">
            <input type="number" v-model="parameter.watermarkHorizontalSpacing" :placeholder="t('pdfToolDetail.upload.settings.horizontal')" :disabled="converting" class="num-input">
            <input type="number" v-model="parameter.watermarkVerticalSpacing" :placeholder="t('pdfToolDetail.upload.settings.vertical')" :disabled="converting" class="num-input">
          </div>
        </div>
      </div>
    </template>

    <!-- 29. Include images -->
    <div v-if="hasContainImg" class="setting-row-switch">
      <div class="setting-label">
        {{ t('pdfToolDetail.upload.settings.includeImages') }}<Tooltip>
          <TooltipTrigger as-child>
            <button type="button" class="tip" :aria-label="t('pdfToolDetail.upload.settings.includeImagesTip')">?</button>
          </TooltipTrigger>
          <TooltipContent>{{ t('pdfToolDetail.upload.settings.includeImagesTip') }}</TooltipContent>
        </Tooltip>:
      </div>
      <label class="switch"><input type="checkbox" v-model="parameter.isContainImg" true-value="1" false-value="0" :disabled="converting"><span class="track"></span></label>
    </div>

    <!-- 30. Include annotations -->
    <div v-if="hasContainAnnotation" class="setting-row-switch">
      <div class="setting-label">
        {{ t('pdfToolDetail.upload.settings.includeAnnotations') }}<Tooltip>
          <TooltipTrigger as-child>
            <button type="button" class="tip" :aria-label="t('pdfToolDetail.upload.settings.includeAnnotationsTip')">?</button>
          </TooltipTrigger>
          <TooltipContent>{{ t('pdfToolDetail.upload.settings.includeAnnotationsTip') }}</TooltipContent>
        </Tooltip>:
      </div>
      <label class="switch"><input type="checkbox" v-model="parameter.isContainAnnot" true-value="1" false-value="0" :disabled="converting"><span class="track"></span></label>
    </div>

    <!-- 31. Formula to image -->
    <div v-if="hasFormulaToImage" class="setting-row-switch">
      <div class="setting-label">
        {{ t('pdfToolDetail.upload.settings.formulaToImage') }}<Tooltip>
          <TooltipTrigger as-child>
            <button type="button" class="tip" :aria-label="t('pdfToolDetail.upload.settings.formulaToImageTip')">?</button>
          </TooltipTrigger>
          <TooltipContent>{{ t('pdfToolDetail.upload.settings.formulaToImageTip') }}</TooltipContent>
        </Tooltip>:
      </div>
      <label class="switch"><input type="checkbox" v-model="parameter.formulaToImage" true-value="1" false-value="0" :disabled="converting"><span class="track"></span></label>
    </div>

    <!-- 34. Page output (one doc per page) -->
    <div v-if="hasPageOneOutput" class="setting-row-switch">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.pageOutput') }}:</div>
      <label class="switch"><input type="checkbox" v-model="parameter.isOutputDocumentPerPage" true-value="1" false-value="0" :disabled="converting"><span class="track"></span></label>
    </div>

    <!-- 35. Retain background -->
    <div v-if="hasRetainBgImg" class="setting-row-switch">
      <div class="setting-label" :class="{ dim: ocrLabelDim }">
        {{ t('pdfToolDetail.upload.settings.retainBackground') }}<Tooltip>
          <TooltipTrigger as-child>
            <button type="button" class="tip" :aria-label="t('pdfToolDetail.upload.settings.retainBackgroundTip')">?</button>
          </TooltipTrigger>
          <TooltipContent>{{ t('pdfToolDetail.upload.settings.retainBackgroundTip') }}</TooltipContent>
        </Tooltip>:
      </div>
      <label class="switch"><input type="checkbox" v-model="parameter.containPageBackgroundImage" true-value="1" false-value="0" :disabled="ocrDisabled"><span class="track"></span></label>
    </div>

    <!-- 36. Transparent text -->
    <div v-if="hasTransparentText" class="setting-row-switch">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.includeTransparentText') }}:</div>
      <label class="switch"><input type="checkbox" v-model="parameter.transparentText" true-value="1" false-value="0" :disabled="converting"><span class="track"></span></label>
    </div>

    <!-- 37. Image format -->
    <div v-if="hasImageFormat" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.imageFormat') }}:</div>
      <div class="setting-control">
        <Select v-model="parameter.imageFormat" :disabled="converting">
          <SelectTrigger class="select-input"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="f in imageFormats" :key="f" :value="f">{{ f.toUpperCase() }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <!-- 38. Allow OCR -->
    <div v-if="hasAllowOcr" class="setting-row-switch">
      <div class="setting-label">
        {{ t('pdfToolDetail.upload.settings.allowOcr') }}<Tooltip>
          <TooltipTrigger as-child>
            <button type="button" class="tip" :aria-label="t('pdfToolDetail.upload.settings.allowOcrTip')">?</button>
          </TooltipTrigger>
          <TooltipContent>{{ t('pdfToolDetail.upload.settings.allowOcrTip') }}</TooltipContent>
        </Tooltip>:
      </div>
      <label class="switch"><input type="checkbox" v-model="parameter.enableOcr" true-value="1" false-value="0" :disabled="converting"><span class="track"></span></label>
    </div>

    <!-- 38.1 OCR language -->
    <div v-if="hasOcrSettings" class="setting-row">
      <div class="setting-label" :class="{ dim: ocrLabelDim }">{{ t('pdfToolDetail.upload.settings.ocrLanguage') }}:</div>
      <div class="setting-control">
        <Select v-model="parameter.ocrRecognitionLang" :disabled="ocrDisabled">
          <SelectTrigger class="select-input"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="lang in ocrLanguages" :key="lang" :value="lang">
              {{ t(`pdfToolDetail.upload.ocrLanguages.${lang}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <!-- 38.2 OCR range -->
    <div v-if="hasOcrSettings" class="setting-row">
      <div class="setting-label" :class="{ dim: ocrLabelDim }">{{ t('pdfToolDetail.upload.settings.ocrRange') }}:</div>
      <div class="setting-control">
        <Select v-model="parameter.ocrOption" :disabled="ocrDisabled">
          <SelectTrigger class="select-input"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in ocrOptions" :key="option" :value="option">
              {{ t(`pdfToolDetail.upload.ocrOptions.${option}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <!-- 39. Merge CSV -->
    <div v-if="hasMergeCsv" class="setting-row-switch">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.mergeCsv') }}:</div>
      <label class="switch"><input type="checkbox" v-model="isCsvMerge" true-value="1" false-value="0" :disabled="converting"><span class="track"></span></label>
    </div>

    <!-- 40. PDF password -->
    <div v-if="hasPassword && !hasSplitOptions" class="setting-row">
      <div class="setting-label">{{ t('pdfToolDetail.upload.settings.password') }}:</div>
      <div class="setting-control">
        <input type="text" v-model="password" :disabled="converting" class="text-input">
      </div>
    </div>

    <!-- 41-43. Encrypt options -->
    <template v-if="hasEncryptOptions">
      <div class="setting-row">
        <div class="setting-label">{{ t('pdfToolDetail.upload.settings.password') }}:</div>
        <div class="setting-control">
          <input type="text" v-model="parameter.encryptUserPassword" :disabled="converting" class="text-input">
        </div>
      </div>
    </template>

    <!-- 44. Merge per-file options -->
    <template v-if="hasMergeOptions">
      <div
        v-for="(selectedFile, index) in files"
        :key="`${selectedFile.name}-${selectedFile.size}-${selectedFile.lastModified}-merge-options`"
        class="merge-file"
      >
        <div class="merge-file-head">
          <span class="merge-file-name">{{ selectedFile.name }}</span>
          <button type="button" class="merge-file-delete" :disabled="converting" @click="deleteMergeFile(index)">×</button>
        </div>
        <div class="merge-field">
          <div class="merge-field-label">{{ t('pdfToolDetail.upload.settings.pageRange') }}</div>
          <input type="text" :placeholder="pageRangePlaceholder" v-model="(parameter.mergeFilePageRanges as string[])[index]" :disabled="converting" class="text-input">
        </div>
        <div class="merge-field">
          <div class="merge-field-label">{{ t('pdfToolDetail.upload.settings.password') }}</div>
          <input type="text" v-model="(parameter.mergePasswords as string[])[index]" :placeholder="t('pdfToolDetail.upload.settings.password')" :disabled="converting" class="text-input">
        </div>
      </div>
    </template>

    <!-- Split file options -->
    <template v-if="hasSplitOptions">
      <div
        v-for="selectedFile in files"
        :key="`${selectedFile.name}-${selectedFile.size}-${selectedFile.lastModified}-split-options`"
        class="split-file-card"
      >
        <div class="split-file-preview">
          <PdfIcon class="split-file-preview-icon" />
          <span class="split-file-preview-name">{{ selectedFile.name }}</span>
          <button type="button" class="split-file-preview-delete" :disabled="converting" @click="deleteFile">
            <DeleteIcon />
          </button>
        </div>
        <label class="split-field">
          <span class="split-field-label">{{ t('pdfToolDetail.upload.settings.pageRange') }}</span>
          <input
            type="text"
            class="text-input split-page-range"
            :placeholder="pageRangePlaceholder"
            v-model="parameter.pageRanges"
            :disabled="converting"
          >
        </label>
        <label class="split-field">
          <span class="split-field-label">{{ t('pdfToolDetail.upload.settings.password') }}</span>
          <input
            type="text"
            class="text-input split-password"
            :placeholder="t('pdfToolDetail.upload.settings.password')"
            v-model="password"
            :disabled="converting"
          >
        </label>
      </div>
    </template>
  </div>
  </TooltipProvider>
</template>

<style scoped>
.param-form {
  margin: 0;
  text-align: left;
}
.file-card-form {
  max-width: 100%;
}

.setting-row,
.setting-row-switch {
  display: flex;
  align-items: center;
  column-gap: 86px;
  min-height: 40px;
  margin-bottom: 10px;
}
.setting-label {
  flex: 0 0 175px;
  margin-top: 0;
  color: #0a0d1c;
  font-size: 14px;
  line-height: 20px;
}
.setting-label.dim {
  color: #ccc;
}
.setting-control {
  flex: 0 1 auto;
  min-width: 0;
}

/* inputs */
.text-input,
.num-input,
.select-input {
  width: 320px;
  max-width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 1px solid #c7cad1;
  border-radius: 8px;
  background: #fff;
  color: #0a0d1c;
  font-size: 16px;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.15s;
}
.file-card-form .text-input {
  width: 100%;
  height: 40px;
  border-radius: 8px;
}
.text-input:focus,
.num-input:focus,
.select-input:focus {
  border-color: #396ffa;
  box-shadow: 0 0 0 2px rgba(57, 111, 250, 0.14);
}
.text-input:disabled,
.num-input:disabled,
.select-input:disabled {
  background: #f5f5f5;
  color: #999;
  cursor: not-allowed;
}
.pair-row {
  display: flex;
  gap: 8px;
}
.pair-row .text-input,
.pair-row .num-input {
  flex: 1;
}

/* radios / checkboxes */
.radio-row,
.radio-stack {
  display: flex;
}
.radio-row {
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
}
.radio-stack {
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.radio-row label,
.radio-stack label,
.flag-item {
  display: flex;
  align-items: center;
  min-height: 20px;
  font-size: 14px;
  line-height: 20px;
  color: #0a0d1c;
  cursor: pointer;
}
.radio-row input[type='radio'],
.radio-stack input[type='radio'] {
  appearance: none;
  display: inline-grid;
  place-content: center;
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  margin: 0 8px 0 0;
  border: 1px solid #d1d5dc;
  border-radius: 50%;
  background: #fff;
  cursor: pointer;
}
.radio-row input[type='radio']::before,
.radio-stack input[type='radio']::before {
  content: '';
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #396ffa;
  transform: scale(0);
  transition: transform 0.12s ease;
}
.radio-row input[type='radio']:checked,
.radio-stack input[type='radio']:checked {
  border-color: #396ffa;
}
.radio-row input[type='radio']:checked::before,
.radio-stack input[type='radio']:checked::before {
  transform: scale(1);
}
.radio-row input[type='radio']:focus-visible,
.radio-stack input[type='radio']:focus-visible {
  outline: 2px solid rgba(57, 111, 250, 0.25);
  outline-offset: 2px;
}
.radio-row input[type='radio']:disabled,
.radio-stack input[type='radio']:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.flag-item {
  margin-bottom: 8px;
}
.flag-item input[type='checkbox'] {
  margin-right: 6px;
  accent-color: #396ffa;
}
.flag-group {
  margin-bottom: 16px;
}
.flag-group-title {
  margin-bottom: 8px;
  font-weight: 500;
  font-size: 14px;
  color: #0a0d1c;
}

/* switch (faux el-switch) */
.switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 18px;
  margin-top: 0;
  cursor: pointer;
}
.switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
}
.switch .track {
  position: absolute;
  inset: 0;
  background: #ced6e1;
  border-radius: 38px;
  transition: background 0.2s;
}
.switch .track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
.switch input:checked + .track {
  background: #396ffa;
}
.switch input:checked + .track::after {
  transform: translateX(22px);
}
.switch input:disabled + .track {
  opacity: 0.6;
  cursor: not-allowed;
}

/* tip marker */
.tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  margin: 0 4px;
  border: 0;
  border-radius: 50%;
  background: #9aa4b2;
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: help;
  vertical-align: middle;
}
.tip:focus-visible {
  outline: 2px solid rgba(57, 111, 250, 0.3);
  outline-offset: 2px;
}

/* file picker */
.pick-btn {
  width: 100%;
  height: 42px;
  padding: 0 12px;
  border: 2px solid #0a0d1c;
  border-radius: 8px;
  background: #fff;
  color: #0a0d1c;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s;
}
.pick-btn:hover:not(:disabled) {
  border-color: #396ffa;
}
.pick-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.file-name {
  margin-top: 8px;
  font-size: 12px;
  line-height: 16px;
  color: #52555f;
  word-break: break-all;
}
.file-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 12px;
  border: 1px solid #ccc;
  border-radius: 4px;
}
.file-chip-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #0a0d1c;
  word-break: break-all;
}
.file-chip-clear {
  flex: none;
  margin-left: 8px;
  border: none;
  background: transparent;
  color: #999;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.file-chip-clear:hover {
  color: #f56565;
}

/* permissions grid */
.perm-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.perm-item {
  display: flex;
  flex-direction: column;
}
.perm-label {
  margin-bottom: 4px;
  font-size: 12px;
  line-height: 16px;
  color: #6a6f77;
}

/* merge per-file */
.merge-file {
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}
.merge-file-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.merge-file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 16px;
  color: #0a0d1c;
  word-break: break-all;
}
.merge-file-delete {
  flex: none;
  margin-left: 8px;
  border: none;
  background: transparent;
  color: #999;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.merge-file-delete:hover {
  color: #f56565;
}
.merge-file-delete:disabled {
  cursor: not-allowed;
}
.merge-field {
  margin-bottom: 8px;
}
.merge-field:last-child {
  margin-bottom: 0;
}
.merge-field-label {
  margin-bottom: 4px;
  font-size: 12px;
  color: #6a6f77;
}

/* split per-file */
.split-file-card {
  position: relative;
  width: 100%;
  margin-bottom: 16px;
  padding: 20px 60px 20px 20px;
  border: 1px solid #e2e3e5;
  border-radius: 8px;
  background: #fbfcff;
}
.split-file-preview {
  display: flex;
  align-items: center;
  min-height: 24px;
  margin-bottom: 12px;
}
.split-file-preview-icon {
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  margin-right: 8px;
}
.split-file-preview-name {
  flex: 1;
  color: #0a0d1c;
  font-size: 16px;
  line-height: 24px;
  word-break: break-all;
}
.split-file-preview-delete {
  position: absolute;
  top: 20px;
  right: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #52555f;
  cursor: pointer;
}
.split-file-preview-delete :deep(svg) {
  width: 20px;
  height: 20px;
}
.split-file-preview-delete:hover {
  color: #f56565;
}
.split-file-preview-delete:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.split-field {
  display: block;
  margin-bottom: 12px;
}
.split-field:last-child {
  margin-bottom: 0;
}
.split-field-label {
  display: block;
  margin-bottom: 4px;
  color: #6a6f77;
  font-size: 14px;
  line-height: 20px;
}
.split-page-range::placeholder,
.split-password::placeholder,
.merge-file .text-input::placeholder {
  color: #9aa4b2;
}

@media (max-width: 768px) {
  .setting-label {
    flex-basis: 120px;
  }
  .perm-grid {
    grid-template-columns: 1fr;
  }
}
</style>
