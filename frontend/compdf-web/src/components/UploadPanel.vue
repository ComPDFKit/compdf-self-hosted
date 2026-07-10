<script setup lang="ts">
/**
 * UploadPanel — the upload lifecycle shell.
 *
 * Owns drag-drop, file list, convert/progress/download/reset buttons, optional
 * format selection, and success state. Parameter controls are delegated to
 * ParamForm.vue. All SDK calls are sync blob-stream POSTs to /api/v1/* via
 * apiClient.
 *
 * State machine:
 *   null → selectType | await | uploading → success → null
 *
 *   - single + pdf/img source → 'await' (show params, then Convert)
 *   - single + other→pdf      → 'uploading' (no params, direct upload)
 *   - multiple + pdf + no toType → 'selectType' (tile grid; not used by the
 *     current catalog because every tool has a fixed toType)
 *   - merge (multiple + toType='merge') → 'await' (file list + merge options)
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AxiosProgressEvent, AxiosResponse } from 'axios';
import { apiClient, downloadBlob, toApiError } from '@/api/client';
import { toolI18nKey } from '@/config/i18n-keys';
import {
  buildRequest,
  defaultParameter,
  type UploadParameter,
} from '@/config/param-schema';
import type { Endpoint, PdfOp } from '@/config/convert-map';
import ParamForm from '@/components/ParamForm.vue';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import UploadIcon from '@/assets/icons/ui/upload.svg?component';
import DeleteIcon from '@/assets/icons/ui/delete.svg?component';
import DownloadIcon from '@/assets/icons/ui/download.svg?component';
import LoadingIcon from '@/assets/icons/ui/loading.svg?component';
import SuccessIcon from '@/assets/icons/ui/success.svg?component';
import DocumentIcon from '@/assets/icons/ui/document.svg?component';
import UnFoldIcon from '@/assets/icons/ui/unfold_current.svg?component';
import FoldIcon from '@/assets/icons/ui/fold_current.svg?component';
import ConvertIcon from '@/assets/icons/ui/convert.svg?component';
import PdfIcon from '@/assets/icons/ui/pdf.svg?component';
import WordIcon from '@/assets/icons/ui/word.svg?component';
import ExcelIcon from '@/assets/icons/ui/excel.svg?component';
import PptIcon from '@/assets/icons/ui/ppt.svg?component';
import HtmlIcon from '@/assets/icons/ui/html.svg?component';
import PngIcon from '@/assets/icons/ui/png.svg?component';
import JpgIcon from '@/assets/icons/ui/jpg.svg?component';
import TxtIcon from '@/assets/icons/ui/txt.svg?component';
import CsvIcon from '@/assets/icons/ui/csv.svg?component';
import RtfIcon from '@/assets/icons/ui/rtf.svg?component';
import JsonIcon from '@/assets/icons/ui/json.svg?component';

type FileStatus = 'await' | 'selectType' | 'uploading' | 'success';

interface FileState {
  status: FileStatus;
  name: string;
  percentage: number | null;
  raw: File;
  rawFiles?: File[];
}

const props = defineProps<{
  fromType: string;
  toType: string;
  mode: 'single' | 'multiple';
  accept: string;
  toolSlug: string;
  endpoint: Endpoint;
}>();

const emit = defineEmits<{
  (e: 'updateStatus', status: string): void;
}>();

const { t } = useI18n();
const isFormalLicense = computed(
  () => window.COMPDF_CONFIG?.isFormalLicense === true,
);

// ---- state refs ------------------------------------------------------------
const file = ref<FileState | null>(null);
const input = ref<HTMLInputElement | null>(null);
const watermarkImageInput = ref<HTMLInputElement | null>(null);
const insertTargetInput = ref<HTMLInputElement | null>(null);

const parameter = ref<UploadParameter>(defaultParameter());
const password = ref('');
const errorText = ref('');
const isCsvMerge = ref('0');

const disabled = ref(false);
const dragover = ref(false);
const onDragenter = ref(false);
const replace = ref(false);
const isAddingFiles = ref(false);
const Converting = ref(false);
const settingsOpen = ref(false);

const insertTargetFile = ref<File | null>(null);
const watermarkImageFile = ref<File | null>(null);

// the most recent blob response — kept so the success-card "Download File"
// button can re-trigger the download without re-uploading.
const blobResponse = ref<AxiosResponse<Blob> | null>(null);

// selectType tile grid state for a generic PDF converter mode.
const type = ref('docx');
const argument = ref(props.toType || 'docx');

const typeMapping = computed<Record<string, { title: string; icon: unknown }>>(() => ({
  docx: { title: t('pdfToolDetail.upload.fileTypes.word'), icon: WordIcon },
  xlsx: { title: t('pdfToolDetail.upload.fileTypes.excel'), icon: ExcelIcon },
  pptx: { title: t('pdfToolDetail.upload.fileTypes.slide'), icon: PptIcon },
  html: { title: t('pdfToolDetail.upload.fileTypes.html'), icon: HtmlIcon },
  png: { title: t('pdfToolDetail.upload.fileTypes.png'), icon: PngIcon },
  jpg: { title: t('pdfToolDetail.upload.fileTypes.jpg'), icon: JpgIcon },
  txt: { title: t('pdfToolDetail.upload.fileTypes.txt'), icon: TxtIcon },
  csv: { title: t('pdfToolDetail.upload.fileTypes.csv'), icon: CsvIcon },
  rtf: { title: t('pdfToolDetail.upload.fileTypes.rtf'), icon: RtfIcon },
  json: { title: t('pdfToolDetail.upload.fileTypes.json'), icon: JsonIcon },
}));

const PDF_ACTION_PROGRESS_KEYS: Record<string, string> = {
  merge: 'pdfToolDetail.upload.merging',
  split: 'pdfToolDetail.upload.splitting',
  insert: 'pdfToolDetail.upload.inserting',
  delete: 'pdfToolDetail.upload.deleting',
  rotate: 'pdfToolDetail.upload.rotating',
  compress: 'pdfToolDetail.upload.compressing',
  'add-watermark': 'pdfToolDetail.upload.addingWatermark',
  'remove-watermark': 'pdfToolDetail.upload.removingWatermark',
  encrypt: 'pdfToolDetail.upload.encrypting',
  decrypt: 'pdfToolDetail.upload.decrypting',
};

const API_ERROR_CODE_KEYS: Record<string, string> = {
  INVALID_REQUEST: 'invalidRequest',
  INVALID_ARGUMENT: 'invalidArgument',
  INVALID_JSON: 'invalidJson',
  CONFLICTING_ARGUMENTS: 'conflictingArguments',
  INVALID_FILE_TYPE: 'invalidFileType',
  FILE_REQUIRED: 'fileRequired',
  FILE_COUNT_MISMATCH: 'fileCountMismatch',
  FILE_TOO_LARGE: 'fileTooLargeAsync',
  PAGE_LIMIT_EXCEEDED: 'pageLimitExceeded',
  INVALID_OUTPUT_FILE_NAME: 'invalidOutputFileName',
  INVALID_PAGE_RANGE: 'invalidPageRange',
  INVALID_PAGE_INDEX: 'invalidPageIndex',
  INVALID_RECT: 'invalidRect',
  PAGE_RANGE_EMPTY: 'pageRangeEmpty',
  PASSWORD_REQUIRED: 'passwordRequired',
  INVALID_PASSWORD: 'invalidPassword',
  INVALID_TOKEN: 'invalidToken',
  AUTH_REQUIRED: 'authRequired',
  NOT_FOUND: 'notFound',
  JOB_NOT_READY: 'jobNotReady',
  INVALID_STATE: 'invalidState',
  CONVERSION_FAILED: 'convertFailed',
  CONVERT_FAILED: 'convertFailed',
  PDF_PASSWORD_ERROR: 'pdfPasswordError',
  PDF_FORMAT_ERROR: 'pdfFormatError',
  PDF_SECURITY_ERROR: 'pdfSecurityError',
  OCR_FAILURE: 'ocrFailure',
  JOB_TIMEOUT: 'jobTimeout',
  REQUEST_TIMEOUT: 'jobTimeout',
  NO_TABLE: 'noTable',
  OUT_OF_MEMORY: 'outOfMemory',
  SDK_FILE_ERROR: 'fileError',
  IMAGE_INVALID: 'imageInvalid',
  INTERNAL_ERROR: 'internalError',
  UPSTREAM_ERROR: 'processFailed',
  BAD_REQUEST: 'invalidRequest',
  VALIDATION_ERROR: 'paramValidation',
  FILE_EMPTY: 'fileEmpty',
  FILE_FORMAT_ERROR: 'fileFormatError',
  UNSUPPORTED_FORMAT: 'unsupportedFormat',
  UNSUPPORTED_IMAGE_FORMAT: 'unsupportedImageFormat',
  FILE_ENCRYPTED: 'fileEncrypted',
  FILE_OPEN_FAILED: 'fileOpenFailed',
  FILE_PROCESS_FAILED: 'fileProcessFailed',
  SDK_PROCESS_FAILED: 'processFailed',
  TEMP_FILE_WRITE_FAILED: 'processFailed',
  TEMP_FILE_READ_FAILED: 'processFailed',
  ICC_PROFILE_REQUIRED: 'paramValidation',
  ICC_PROFILE_INVALID: 'paramValidation',
  INVALID_QUAD_RECTS: 'invalidRect',
};

const API_NUMERIC_CODE_KEYS: Record<number, string> = {
  100001: 'invalidRequest',
  100002: 'invalidJson',
  100003: 'conflictingArguments',
  100101: 'invalidFileType',
  100102: 'fileRequired',
  100103: 'fileCountMismatch',
  100104: 'fileTooLargeAsync',
  100105: 'pageLimitExceeded',
  100106: 'invalidOutputFileName',
  110001: 'invalidPageRange',
  110002: 'invalidPageIndex',
  110003: 'invalidRect',
  110005: 'pageRangeEmpty',
  120001: 'passwordRequired',
  120002: 'invalidPassword',
  140001: 'authRequired',
  140002: 'invalidToken',
  150001: 'notFound',
  150002: 'jobNotReady',
  150003: 'invalidState',
  190001: 'convertFailed',
  190002: 'pdfPasswordError',
  190003: 'pdfFormatError',
  190004: 'pdfSecurityError',
  190005: 'ocrFailure',
  190006: 'jobTimeout',
  190007: 'noTable',
  190008: 'outOfMemory',
  190009: 'fileError',
  190010: 'imageInvalid',
};

const convertButtonLabel = computed(() => (
  props.endpoint.kind === 'pdf' ? t(toolI18nKey(props.toolSlug)) : t('pdfToolDetail.upload.convert')
));

const actionInProgressText = computed(() => (
  t(PDF_ACTION_PROGRESS_KEYS[props.toolSlug] ?? 'pdfToolDetail.upload.convertingAction')
));

const canSelectMultiple = computed(() => props.mode === 'multiple');
const isSplitTool = computed(() => props.toType === 'split');
const isTaskRunning = computed(() => Converting.value || file.value?.status === 'uploading');

const selectedFiles = computed<File[]>(() => {
  if (!file.value) return [];
  return file.value.rawFiles ?? [file.value.raw];
});

function defaultSettingsOpen(nextFromType = props.fromType, nextToType = props.toType): boolean {
  void nextFromType;
  void nextToType;
  return true;
}

// ---- emit updateStatus on every file.status change (for StepTitle) ----
watch(
  () => file.value,
  (val) => {
    emit('updateStatus', val?.status ?? '');
  },
  { deep: true },
);

// reset when the tool changes (user navigates to a different tool)
watch(
  () => [props.accept, props.fromType, props.toType],
  ([newAccept, newFromType, newToType]) => {
    reset();
    settingsOpen.value = defaultSettingsOpen(String(newFromType), String(newToType));
    void newAccept;
  },
);

// ---- file selection / validation ------------------------------------------

function matchesAccept(accept: string, ext: string): boolean {
  return accept.toLowerCase().indexOf(ext.toLowerCase()) >= 0;
}

/**
 * Shared selection validation for both the file-input change path and the
 * drag-drop path. Returns the i18n key of the first violated rule, or null
 * when the selection is acceptable. Keeps the two entry points consistent so
 * a dropped file can't bypass the size / extension / merge-limit checks.
 */
function validateSelection(fileArray: File[]): string | null {
  if (props.endpoint.kind === 'pdf' && fileArray.some((f) => !f.name.toLowerCase().endsWith('.pdf'))) {
    return 'pdfToolDetail.upload.errors.invalidPdf';
  }
  if (props.toType === 'merge') {
    const existing = isAddingFiles.value && file.value?.rawFiles ? file.value.rawFiles.length : 0;
    if (existing + fileArray.length > 5) return 'pdfToolDetail.upload.errors.mergeFileLimit';
  }
  return null;
}

function handleChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const files = target.files;
  if (!files || files.length === 0) return;
  const fileArray = Array.from(files);
  const err = validateSelection(fileArray);
  if (err) { errorText.value = t(err); return; }
  uploadFiles(fileArray);
}

function uploadFiles(fileList: File[]) {
  if (fileList.length === 0) return;
  const postFile = fileList[0];
  const splitName = postFile.name.split('.');
  const formate = splitName[splitName.length - 1].toLowerCase();

  if (!matchesAccept(props.accept, formate)) {
    errorText.value = t('pdfToolDetail.upload.errors.invalidPdf');
    return;
  }
  errorText.value = '';

  // merge append flow: adding more files to an existing merge list
  if (isAddingFiles.value && file.value?.rawFiles && canSelectMultiple.value) {
    isAddingFiles.value = false;
    file.value.rawFiles = [...file.value.rawFiles, ...fileList];
    if (props.toType === 'merge') {
      const p = parameter.value as UploadParameter & { mergeFilePageRanges?: string[]; mergePasswords?: string[] };
      p.mergeFilePageRanges = [...(p.mergeFilePageRanges ?? []), ...fileList.map(() => '')];
      p.mergePasswords = [...(p.mergePasswords ?? []), ...fileList.map(() => '')];
    }
    return;
  }

  const noConversion = ['pdf', 'img'].includes(props.fromType) && props.mode !== 'multiple';
  const conversion = formate === 'pdf';
  // selectType only fires for a generic converter with an empty toType.
  const selectTypeBranch = !props.toType && props.mode === 'multiple' && conversion && !replace.value;
  const status: FileStatus = selectTypeBranch
    ? 'selectType'
    : noConversion || conversion
      ? 'await'
      : 'uploading';

  file.value = { status, name: postFile.name, percentage: 0, raw: postFile };
  settingsOpen.value = defaultSettingsOpen();
  if (canSelectMultiple.value) file.value.rawFiles = fileList;

  if (props.toType === 'merge') {
    const p = parameter.value as UploadParameter & { mergeFilePageRanges?: string[]; mergePasswords?: string[] };
    p.mergeFilePageRanges = fileList.map((_, i) => p.mergeFilePageRanges?.[i] ?? '');
    p.mergePasswords = fileList.map((_, i) => p.mergePasswords?.[i] ?? '');
  }

  disabled.value = true;
  if (status === 'uploading') {
    void upload(postFile);
  }
}

function handleClick(action?: 'add' | 'replace') {
  if (isTaskRunning.value) return;
  if (action === 'replace') {
    replace.value = true;
    Converting.value = false;
    if (file.value) file.value.percentage = null;
    init();
  } else if (action === 'add') {
    isAddingFiles.value = true;
    replace.value = false;
  } else {
    if (disabled.value) return;
    init();
  }
  errorText.value = '';
  if (input.value) {
    input.value.value = '';
    input.value.click();
  }
}

function onDrop(e: DragEvent) {
  if (disabled.value) return;
  dragover.value = false;
  const files = e.dataTransfer?.files;
  if (!files) return;
  const fileArray = Array.from(files);
  const err = validateSelection(fileArray);
  if (err) { errorText.value = t(err); return; }
  init();
  uploadFiles(fileArray);
}

function onDragover() {
  if (!disabled.value) dragover.value = true;
}

function handleDelete() {
  if (isTaskRunning.value) return;
  init();
  file.value = null;
  errorText.value = '';
  replace.value = false;
  disabled.value = false;
  Converting.value = false;
  watermarkImageFile.value = null;
  insertTargetFile.value = null;
  if (watermarkImageInput.value) watermarkImageInput.value.value = '';
  if (insertTargetInput.value) insertTargetInput.value.value = '';
}

// ---- convert / upload ------------------------------------------------------

function handleConvert(val: boolean) {
  if (!file.value) return;
  if (props.toType === 'merge' && (file.value.rawFiles?.length ?? 0) < 2) {
    errorText.value = t('pdfToolDetail.upload.errors.mergeRequired');
    return;
  }
  if (props.toType === 'addWatermark' && parameter.value.watermarkType === 'image' && !watermarkImageFile.value) {
    errorText.value = t('pdfToolDetail.upload.errors.watermarkImageRequired');
    return;
  }
  if (props.toType === 'insert' && parameter.value.insertActionType === 'FROM_PDF' && !insertTargetFile.value) {
    errorText.value = t('pdfToolDetail.upload.errors.insertFileCount');
    return;
  }
  if (props.mode === 'multiple') {
    if (val) {
      void upload(file.value.raw);
      Converting.value = true;
    } else {
      if (!type.value) return;
      init();
      file.value.status = 'await';
    }
  } else {
    void upload(file.value.raw);
    Converting.value = true;
  }
  errorText.value = '';
}

/** selectType tile grid handler (generic converter only — not in current catalog). */
function conversion(t_: string) {
  type.value = t_;
}

function effectivePdfOp(op: PdfOp): PdfOp {
  if (op === 'insert-from-pdf' && parameter.value.insertActionType === 'BLANK') {
    return 'insert-blank';
  }
  return op;
}

function processPath(ep: Endpoint): string {
  if (ep.kind === 'convert-target') return `/process/pdf/${ep.target}`;
  if (ep.kind === 'convert-type') return `/process/${ep.type}`;
  if (ep.kind === 'convert-to-pdf') return `/process/${ep.type ?? 'pdf'}`;
  return '';
}

/**
 * Build the multipart FormData per the server contract and POST it as a
 * blob stream. Field names confirmed against the server controllers:
 *   - /process/pdf/merge            → files
 *   - /process/pdf/insert-from-pdf  → file + insertFile
 *   - /process/pdf/watermark/add    → file + imageFile
 *   - other /process/pdf/{op}       → file
 *   - /process/{source}/{target} → FileInterceptor('file'); the server maps the
 *     OpenAPI-style process path to target/type/convert-to-pdf upstream calls
 * buildRequest decides field='request' (pdf ops, password inline) vs
 * field='options' (conversions, password separate). A sibling `password` part
 * is appended ONLY when passwordField='separate' AND the password is non-empty
 * (the pdf controller's extractRequest DROPS a sibling password when `request`
 * is present, so pdf ops inject it inline via buildRequest).
 */
async function upload(rawFile: File) {
  if (!file.value) return;
  if (input.value) input.value.value = '';

  // primary file list — insertTargetFile/watermarkImageFile travel via
  // buildRequest's extraFiles/imageFile, NOT in this list.
  let uploadFileList: File[];
  if (props.toType === 'merge') {
    uploadFileList = file.value.rawFiles ?? [rawFile];
  } else {
    uploadFileList = [rawFile];
  }

  const r = buildRequest({
    toType: props.toType,
    fromType: props.fromType,
    parameter: parameter.value,
    password: password.value,
    files: uploadFileList,
    insertTargetFile: insertTargetFile.value ?? undefined,
    watermarkImageFile: watermarkImageFile.value ?? undefined,
    isCsvMerge: isCsvMerge.value === '1',
  });

  const ep = props.endpoint;
  const fd = new FormData();
  const pdfOp = ep.kind === 'pdf' ? effectivePdfOp(ep.op) : null;

  // 1. files — field name depends on the route (see contract above)
  if (ep.kind === 'pdf') {
    if (pdfOp === 'merge') {
      uploadFileList.forEach((f) => fd.append('files', f));
    } else if (pdfOp === 'insert-from-pdf') {
      fd.append('file', uploadFileList[0]);
      if (r.extraFiles?.[0]) fd.append('insertFile', r.extraFiles[0]);
    } else if (pdfOp === 'watermark/add') {
      fd.append('file', uploadFileList[0]);
      if (r.imageFile) fd.append('imageFile', r.imageFile);
    } else {
      fd.append('file', uploadFileList[0]);
    }
  } else {
    fd.append('file', uploadFileList[0]);
  }

  // 2. the parameter/options payload (JSON string under 'request' or 'options')
  fd.append(r.field, JSON.stringify(r.payload));

  // 3. password — separate field ONLY for conversions with a non-empty password
  if (r.passwordField === 'separate' && password.value) {
    fd.append('password', password.value);
  }

  // 4. route URL + flat fields (target/type) per the tool's Endpoint
  let url = '';
  if (ep.kind === 'pdf') {
    url = `/process/pdf/${pdfOp}`;
  } else if (ep.kind === 'convert-target') {
    url = processPath(ep);
  } else if (ep.kind === 'convert-type') {
    url = processPath(ep);
  } else {
    url = processPath(ep);
  }

  try {
    const res = await apiClient.post(url, fd, {
      responseType: 'blob',
      onUploadProgress: (e: AxiosProgressEvent) => {
        if (file.value) file.value.percentage = Math.floor((e.loaded / (e.total || 1)) * 100);
      },
    });
    Converting.value = false;
    blobResponse.value = res as AxiosResponse<Blob>;
    file.value.status = 'success';
    downloadBlob(res as AxiosResponse<Blob>, fallbackFilename());
  } catch (err) {
    Converting.value = false;
    errorText.value = apiErrorMessage(await toApiError(err));
    disabled.value = false;
    if (file.value) file.value.percentage = null;
  }
}

function apiErrorMessage(error: Awaited<ReturnType<typeof toApiError>>): string {
  const key = apiErrorKey(error);
  return key ? t(`pdfToolDetail.upload.errors.apiCodes.${key}`) : error.message;
}

function apiErrorKey(error: Awaited<ReturnType<typeof toApiError>>): string | null {
  if (error.errorCode && API_ERROR_CODE_KEYS[error.errorCode]) {
    return API_ERROR_CODE_KEYS[error.errorCode];
  }
  // Upstream SDK numeric business code lives in `bizCode` (code is the HTTP status).
  if (typeof error.bizCode === 'number' && API_NUMERIC_CODE_KEYS[error.bizCode]) {
    return API_NUMERIC_CODE_KEYS[error.bizCode];
  }
  return null;
}

function downloadFile() {
  if (blobResponse.value) {
    downloadBlob(blobResponse.value, fallbackFilename());
  }
}

function reset() {
  init();
  file.value = null;
  disabled.value = false;
  Converting.value = false;
  settingsOpen.value = defaultSettingsOpen();
}

function init() {
  parameter.value = defaultParameter();
  password.value = '';
  isCsvMerge.value = '0';
  watermarkImageFile.value = null;
  insertTargetFile.value = null;
  if (watermarkImageInput.value) watermarkImageInput.value.value = '';
  if (insertTargetInput.value) insertTargetInput.value.value = '';
}

// hidden-input handlers for the watermark image + insert target file. These
// inputs live here because UploadPanel owns the refs upload() needs; ParamForm
// triggers their .click() and receives the selected filename through v-models.
function handleWatermarkImageChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const selected = target.files?.[0];
  if (!selected) return;
  if (!/\.(jpe?g|png|bmp)$/i.test(selected.name)) {
    errorText.value = t('pdfToolDetail.upload.errors.invalidWatermarkImage');
    target.value = '';
    return;
  }
  errorText.value = '';
  watermarkImageFile.value = selected;
  target.value = '';
}

function handleInsertTargetChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const selected = target.files?.[0];
  if (!selected) return;
  if (!selected.name.toLowerCase().endsWith('.pdf')) {
    errorText.value = t('pdfToolDetail.upload.errors.invalidPdf');
    target.value = '';
    return;
  }
  errorText.value = '';
  insertTargetFile.value = selected;
  target.value = '';
}

/**
 * Per-file delete in the merge list (ParamForm's `delete-merge-file` event).
 * UploadPanel owns rawFiles, so it owns the splice across all three parallel
 * arrays (rawFiles + mergeFilePageRanges + mergePasswords). When the last file
 * is removed, fall through to a full reset.
 */
function handleMergeFileDelete(index: number) {
  if (!file.value?.rawFiles) return;
  file.value.rawFiles.splice(index, 1);
  const p = parameter.value as UploadParameter & { mergeFilePageRanges?: string[]; mergePasswords?: string[] };
  p.mergeFilePageRanges?.splice(index, 1);
  p.mergePasswords?.splice(index, 1);
  if (file.value.rawFiles.length === 0) {
    handleDelete();
  }
}

function outputExtension(toType: string, ep: Endpoint): string {
  if (ep.kind === 'pdf') return ep.op === 'split' ? 'zip' : 'pdf';
  if (toType === 'searchablePdf') return 'pdf';
  return toType || 'pdf';
}

function fallbackFilename(): string {
  const base = file.value?.raw?.name?.replace(/\.[^.]+$/, '') || 'output';
  return `${base}.${outputExtension(props.toType, props.endpoint)}`;
}
</script>

<template>
  <!-- success card -->
  <div v-if="file && file.status === 'success'" class="success-card">
    <div class="success-main">
      <div class="success-copy">
        <div class="success-hero" aria-hidden="true">
          <SuccessIcon class="success-icon" />
        </div>
        <h2 class="success-title">{{ t('pdfToolDetail.upload.successTitle') }}</h2>
      </div>
      <div class="success-file-wrap">
        <div class="success-file">
          <DocumentIcon class="success-file-icon" />{{ fallbackFilename() }}
        </div>
      </div>
      <div class="success-actions">
        <button class="btn download-btn success-action-btn" @click="downloadFile">
          <DownloadIcon class="btn-icon" />{{ t('pdfToolDetail.upload.downloadFile') }}
        </button>
        <button class="reset" @click="reset">
          <LoadingIcon class="reset-icon" />{{ t('pdfToolDetail.upload.startOver') }}
        </button>
      </div>
    </div>
    <div v-if="!isFormalLicense" class="trial-limit-banner">
      <span class="trial-limit-icon">!</span>
      <p>{{ t('pdfToolDetail.upload.trialLimit') }}</p>
      <a href="https://www.compdf.com/contact-sales" target="_blank">{{ t('pdfToolDetail.upload.upgradeNow') }}</a>
    </div>
  </div>

  <div
    v-else
    class="converter-wrapper"
    :class="{ hover: onDragenter && !file, params: file && file.status === 'await', 'no-pad': !file }"
    @dragover="onDragenter = true"
    @dragleave="onDragenter = false"
  >
    <template v-if="file && file.status === 'await'">
      <div v-if="mode === 'multiple' && typeMapping[argument]" class="await-header">
        <component :is="typeMapping[argument].icon" class="await-header-icon" />
        {{ t('pdfToolDetail.upload.pdfTo', { type: typeMapping[argument].title }) }}
      </div>

      <div class="name">
        <div class="name-list">
          <div
            v-for="selectedFile in selectedFiles"
            :key="`${selectedFile.name}-${selectedFile.size}-${selectedFile.lastModified}`"
            class="name-item"
          >
            <PdfIcon class="name-item-icon" /> {{ selectedFile.name }}
          </div>
        </div>
        <button type="button" class="name-delete" :disabled="isTaskRunning" @click.stop="handleDelete">
          <DeleteIcon />
        </button>
      </div>

      <div class="await-actions">
        <button
          type="button"
          class="select-more"
          :disabled="isTaskRunning"
          @click="handleClick(canSelectMultiple ? 'add' : 'replace')"
        >
          {{ t('pdfToolDetail.upload.selectFile') }}
        </button>
      </div>

      <div class="frame"></div>

      <div v-if="!['pdf', 'img'].includes(fromType)" class="err-text" >{{ errorText }}</div>

      <Collapsible v-model:open="settingsOpen" class="settings-row" :class="{ 'split-settings-row': isSplitTool }">
        <CollapsibleTrigger v-if="fromType !== 'img' && toType !== 'merge'" as-child>
          <div class="settings-toggle">
            <UnFoldIcon v-if="!settingsOpen" />
            <FoldIcon v-else />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent class="settings-body">
          <ParamForm
            v-if="file.status === 'await'"
            v-model:parameter="parameter"
            v-model:password="password"
            v-model:is-csv-merge="isCsvMerge"
            v-model:watermark-image-file="watermarkImageFile"
            v-model:insert-target-file="insertTargetFile"
            :from-type="fromType"
            :to-type="toType"
            :files="selectedFiles"
            :converting="Converting"
            @pick-watermark-image="watermarkImageInput?.click()"
            @pick-insert-target="insertTargetInput?.click()"
            @delete-merge-file="handleMergeFileDelete"
            @delete-file="handleDelete"
          />
        </CollapsibleContent>
      </Collapsible>

      <div v-if="['pdf', 'img'].includes(fromType)" class="err-text" >{{ errorText }}</div>

      <!-- convert / progress / converting buttons -->
      <button v-if="!file.percentage" type="button" class="btn select-btn action-btn" @click="handleConvert(true)">
        {{ convertButtonLabel }}
      </button>
      <div v-else-if="file.status === 'await' && file.percentage !== 100" class="btn upload-btn action-btn">
        <div class="progress-bar" :style="{ maxWidth: (file.percentage || 0) + '%' }"></div>
        <div class="uploading-text">
          {{ actionInProgressText }} - {{ file.percentage }}%
        </div>
      </div>
      <div v-else-if="file.status === 'await' && file.percentage === 100" class="btn converting-btn action-btn">
        <LoadingIcon class="btn-icon spin" />{{ actionInProgressText }}
      </div>
    </template>

    <!-- drag / select zone (no file yet) OR selectType grid OR uploading -->
    <div
      class="upload-dragger"
      :class="{ 'is-dragover': dragover, hidden: file && file.status === 'await', processing: file?.status === 'uploading' }"
      @drop.prevent="onDrop"
      @dragover.prevent="onDragover"
      @dragleave.prevent="dragover = false"
    >
      <template v-if="!file">
        <div class="err-text" >{{ errorText }}</div>
        <button type="button" class="btn select-btn" @click="handleClick()">
          <UploadIcon class="btn-icon" />{{ t('pdfToolDetail.upload.selectFile') }}
        </button>
        <div class="upload-text">{{ t('pdfToolDetail.upload.dragDrop') }}</div>
      </template>

      <template v-else-if="file.status === 'selectType'">
        <div class="select-header">
          <ConvertIcon class="select-header-icon" />{{ t('pdfToolDetail.upload.pdfConverter') }}
        </div>
        <div class="select-type">
          <div class="type-item" :class="{ active: type === 'docx' }" @click="conversion('docx')">
            <WordIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.word') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'xlsx' }" @click="conversion('xlsx')">
            <ExcelIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.excel') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'pptx' }" @click="conversion('pptx')">
            <PptIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.slide') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'html' }" @click="conversion('html')">
            <HtmlIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.html') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'png' }" @click="conversion('png')">
            <PngIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.png') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'jpg' }" @click="conversion('jpg')">
            <JpgIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.jpg') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'txt' }" @click="conversion('txt')">
            <TxtIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.txt') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'csv' }" @click="conversion('csv')">
            <CsvIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.csv') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'rtf' }" @click="conversion('rtf')">
            <RtfIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.rtf') }}</span>
          </div>
          <div class="type-item" :class="{ active: type === 'json' }" @click="conversion('json')">
            <JsonIcon /><span class="type-text">{{ t('pdfToolDetail.upload.fileTypes.json') }}</span>
          </div>
        </div>
        <button type="button" class="btn convert-btn" @click="handleConvert(false)">
          {{ t('pdfToolDetail.upload.convertFile') }}
        </button>
      </template>

      <div v-else-if="file.status === 'uploading' && file.percentage !== 100" class="btn upload-btn action-btn">
        <div class="progress-bar" :style="{ maxWidth: (file.percentage || 0) + '%' }"></div>
        <div class="uploading-text">
          {{ t('pdfToolDetail.upload.uploadingProgress', { percent: file.percentage }) }}
        </div>
      </div>
      <div v-else-if="file.status === 'uploading' && file.percentage === 100" class="btn converting-btn action-btn">
        <LoadingIcon class="btn-icon spin" />{{ t('pdfToolDetail.upload.converting') }}
      </div>
    </div>

    <!-- hidden file inputs -->
    <input
      ref="input"
      class="upload-input"
      type="file"
      name="file"
      :accept="accept"
      :multiple="canSelectMultiple"
      @change="handleChange"
    />
    <input
      ref="watermarkImageInput"
      class="upload-input"
      type="file"
      accept=".jpg,.jpeg,.png,.bmp"
      @change="handleWatermarkImageChange"
    />
    <input
      ref="insertTargetInput"
      class="upload-input"
      type="file"
      accept=".pdf"
      @change="handleInsertTargetChange"
    />
  </div>
</template>

<style scoped>
.converter-wrapper {
  position: relative;
  padding: 40px;
  border: 1px solid #d1d5dc;
  border-radius: 8px;
  background: #fbfcff;
  transition: box-shadow 0.2s;
}
.converter-wrapper.hover {
  box-shadow: 0 0 0 2px #396ffa inset;
}
.converter-wrapper.params {
  padding: 32px 32px 40px;
  min-height: 380px;
}
.converter-wrapper.no-pad {
  padding: 0;
  border: 0;
  background: transparent;
}

/* ---- await state ---- */
.await-header {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  font-size: 24px;
  font-weight: 600;
  color: #232748;
}
.await-header-icon {
  width: 32px;
  height: 32px;
  margin-right: 16px;
}
.name {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  min-height: 56px;
  margin: 36px 0 48px;
  padding: 8px 12px;
  background: #fff;
  border-radius: 4px;
}
.name-list {
  flex: 1;
  min-width: 0;
}
.name-item {
  display: flex;
  align-items: center;
  min-height: 40px;
  margin-bottom: 12px;
  font-size: 16px;
  font-weight: 500;
  color: #0a0d1c;
  line-height: 24px;
  word-break: break-all;
}
.name-item:last-child {
  margin-bottom: 0;
}
.name-item-icon {
  flex: none;
  width: 40px;
  height: 40px;
  margin-right: 12px;
}
.name-delete {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  margin-left: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #52555f;
  cursor: pointer;
}
.name-delete :deep(svg) {
  width: 20px;
  height: 20px;
}
.name-delete:hover {
  color: #f56565;
}
.name-delete:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.await-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0;
}
.converter-wrapper.params .await-actions {
  position: absolute;
  top: 8px;
  right: 32px;
  z-index: 3;
}
.converter-wrapper.params .split-await-actions {
  position: static;
  margin-bottom: 32px;
}
.select-more {
  min-width: 139px;
  padding: 0 16px;
  height: 40px;
  border: 1px solid #396ffa;
  border-radius: 8px;
  background: #fff;
  color: #396ffa;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}
.select-more:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.frame {
  height: 1px;
  margin: 0 0 40px;
  background: repeating-linear-gradient(90deg, #d1d5dc 0 4px, transparent 4px 12px);
}
.err-text {
  min-height: 20px;
  margin: 8px 0;
  color: #f56565;
  font-size: 13px;
  text-align: center;
  word-break: break-word;
}
.err-text :deep(a) {
  color: #396ffa;
  text-decoration: underline;
}
.settings-row {
  position: relative;
  text-align: left;
}
.split-settings-row {
  padding-top: 44px;
}
.settings-toggle {
  position: absolute;
  right: 0px;
  top: 12px;
  z-index: 2;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #d1d5dc;
  background: #396ffa;
  border-radius: 4px;
  cursor: pointer;
}
.split-settings-row .settings-toggle {
  top: 0;
}
.settings-toggle :deep(svg) {
  color: #e5ecff;
}
.settings-body {
  margin: 0 auto;
  text-align: left;
}

/* ---- drag / select zone ---- */
.upload-dragger {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 380px;
  padding: 56px 40px;
  border: 2px dashed #c7cad1;
  border-radius: 12px;
  background: #fbfcff;
  transition: border-color 0.2s, background 0.2s;
}
.upload-dragger.is-dragover {
  border-color: #396ffa;
  background: #eef3ff;
}
.upload-dragger.processing {
  border: 2px solid transparent;
  background: transparent;
  transition: none;
}
.upload-dragger.hidden {
  display: none;
}
.upload-text {
  margin-top: 16px;
  color: #6b6375;
  font-size: 14px;
}
.note {
  margin-top: 12px;
  color: #b1bfd1;
  font-size: 12px;
}

/* ---- selectType grid ---- */
.select-header {
  display: flex;
  align-items: center;
  font-size: 24px;
  font-weight: 600;
  color: #232748;
  margin-bottom: 32px;
}
.select-header-icon {
  width: 32px;
  height: 32px;
  margin-right: 16px;
}
.select-type {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 16px;
  margin-bottom: 32px;
}
.type-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 8px;
  border: 1px solid #e5ecff;
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.type-item:hover {
  border-color: #396ffa;
}
.type-item.active {
  border-color: #396ffa;
  background: #eef3ff;
}
.type-item :deep(svg) {
  width: 36px;
  height: 36px;
}
.type-text {
  font-size: 13px;
  color: #52555f;
}

/* ---- buttons ---- */
.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 24px auto 0;
  padding: 0 24px;
  height: 48px;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.btn-icon {
  width: 20px;
  height: 20px;
  margin-right: 8px;
}
.select-btn {
  background: #396ffa;
  color: #fff;
}
.upload-dragger > .select-btn {
  width: 300px;
  height: 48px;
  margin-top: 0;
  border-radius: 8px;
  font-size: 16px;
  line-height: 24px;
}
.converter-wrapper.params > .select-btn,
.converter-wrapper.params > .upload-btn,
.converter-wrapper.params > .converting-btn {
  width: fit-content;
  min-width: min(100%, 128px);
  max-width: 100%;
  height: 40px;
  min-height: 40px;
  margin-top: 40px;
  padding: 0 24px;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
  white-space: nowrap;
}
.select-btn:hover {
  background: #2b59e0;
}
.convert-btn {
  background: #0a0d1c;
  color: #fff;
}
.convert-btn:hover {
  opacity: 0.9;
}
.upload-btn {
  position: relative;
  background: #396ffa;
  color: #fff;
  overflow: hidden;
  cursor: default;
}
.progress-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 100%;
  background: #1f49c1;
  transition: max-width 0.6s ease;
}
.uploading-text {
  position: relative;
  z-index: 1;
  color: #fff;
  font-weight: 700;
  white-space: nowrap;
}
.converting-btn {
  background: #396ffa;
  color: #fff;
  cursor: default;
}
.download-btn {
  background: #396ffa;
  color: #fff;
}
.success-card .download-btn {
  width: 264px;
  height: 40px;
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.download-btn:hover {
  background: #2b59e0;
}
.spin {
  animation: up-spin 1s linear infinite;
}
@keyframes up-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---- success card ---- */
.success-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  justify-content: center;
  width: 100%;
  min-height: 342px;
  margin-top: 48px;
  padding: 32px 42px 24px;
  background: #fff;
  border: 1px solid #d1d5dc;
  border-radius: 12px;
  text-align: center;
}
.success-main {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 32px;
}
.success-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.success-hero {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 180px;
  height: 147px;
}
.success-hero::before,
.success-hero::after {
  content: '';
  position: absolute;
  width: 10px;
  height: 10px;
  background: #8df0ce;
  transform: rotate(45deg);
}
.success-hero::before {
  left: 42px;
  top: 58px;
}
.success-hero::after {
  right: 49px;
  top: 29px;
}
.success-icon {
  width: 88px;
  height: 88px;
  padding: 8px;
  border-radius: 999px;
  background: #a7ebdc;
  color: #31bc98;
}
.success-title {
  margin: 0;
  color: #0a0d1c;
  font-size: 30px;
  font-weight: 600;
  line-height: 40px;
}
.success-file-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.success-file {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  color: #0a0d1c;
  font-size: 14px;
  line-height: 20px;
  word-break: break-all;
}
.success-file-icon {
  width: 20px;
  height: 20px;
  margin-right: 8px;
  flex: none;
}
.success-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  width: 264px;
  max-width: 100%;
}
.reset {
  display: flex;
  align-items: center;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: #0a0d1c;
  font-size: 16px;
  line-height: 24px;
  cursor: pointer;
}
.reset:hover {
  color: #396ffa;
}
.reset-icon {
  width: 14px;
  height: 14px;
  margin-right: 8px;
}
.trial-limit-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #fcd980;
  border-radius: 8px;
  background: rgba(252, 217, 128, 0.2);
}
.trial-limit-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: #fcd980;
  color: #fc7125;
  font-size: 14px;
  font-weight: 700;
}
.trial-limit-banner p {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: #0a0d1c;
  font-size: 14px;
  line-height: 20px;
  text-align: left;
}
.trial-limit-banner a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #d1d5dc;
  border-radius: 4px;
  background: #fff;
  color: #396ffa;
  font-size: 14px;
  line-height: 20px;
  text-decoration: none;
}

.upload-input {
  display: none;
}

@media (max-width: 768px) {
  .converter-wrapper {
    padding: 24px 16px;
  }
  .select-type {
    grid-template-columns: repeat(3, 1fr);
  }
  .await-header {
    font-size: 20px;
  }
  .success-card {
    padding: 28px 16px 20px;
  }
  .success-title {
    font-size: 24px;
    line-height: 32px;
    white-space: normal;
  }
  .trial-limit-banner {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .trial-limit-banner a {
    margin-left: 32px;
  }
}
</style>
