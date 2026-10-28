<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onClickOutside } from '@vueuse/core';
import type { AxiosResponse } from 'axios';
import { apiClient, toApiError, parseContentDispositionFilename } from '@/api/client';
import { apiErrorTranslationKey } from '@/api/error-localization';
import { batchApi, buildBatchRequest, type BatchInfo } from '@/api/batch';
import type { Endpoint } from '@/config/convert-map';
import { toolI18nKey } from '@/config/i18n-keys';
import { buildRequest, defaultParameter, watermarkValidationKey, compressImageQualityValidationKey, deletePageRangeValidationKey, encryptPasswordValidationKey, imageDpiValidationKey, insertSourcePageRangeValidationKey } from '@/config/param-schema';
import { buildStampRequest, defaultStampParameter, stampValidationKey } from '@/config/stamp-schema';
import { droppedFiles, fileValidationKey, parsePages, splitCustomRanges, type PickedFile, type SplitMode } from '@/utils/batch-files';
import { nameSplitOutputs, saveBlob, zipFiles } from '@/utils/result-archive';
import { randomUuid } from '@/utils/random-uuid';
import ParamForm from './ParamForm.vue';
import StampSettings from './StampSettings.vue';
import SplitSettings from './SplitSettings.vue';
import WatermarkSettings from './WatermarkSettings.vue';
import { CONVERSION_FEATURES } from '@/config/param-schema';
import UploadIcon from '@/assets/icons/ui/batch-upload.svg?component';
import FolderIcon from '@/assets/icons/ui/batch-folder.svg?component';
import DeleteIcon from '@/assets/icons/ui/batch-delete.svg?component';
import DownloadIcon from '@/assets/icons/ui/batch-result-download.svg?component';
import DocumentIcon from '@/assets/icons/ui/batch-file.svg?component';
import DragHandleIcon from '@/assets/icons/ui/batch-drag.svg?component';
import UploadOutlineIcon from '@/assets/icons/ui/batch-upload-outline.svg?component';
import ChevronIcon from '@/assets/icons/ui/batch-chevron.svg?component';
import ClearIcon from '@/assets/icons/ui/batch-clear.svg?component';
import LockIcon from '@/assets/icons/ui/batch-lock.svg?component';
import EyeOffIcon from '@/assets/icons/ui/batch-eye-off.svg?component';
import WaitingIcon from '@/assets/icons/ui/batch-status-waiting.svg?component';
import SuccessIcon from '@/assets/icons/ui/batch-status-success.svg?component';
import FailedIcon from '@/assets/icons/ui/batch-status-failed.svg?component';
import RetryIcon from '@/assets/icons/ui/batch-retry.svg?component';
import ResetIcon from '@/assets/icons/ui/batch-reset.svg?component';
import WarningIcon from '@/assets/icons/ui/batch-warning.svg?component';
import spinnerUrl from '@/assets/icons/ui/batch-spinner.png';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const props = defineProps<{ fromType: string; toType: string; mode: 'single' | 'multiple'; accept: string; toolSlug: string; endpoint: Endpoint }>();
const emit = defineEmits<{ (e: 'updateStatus', status: string): void }>();
const { t } = useI18n();
type RowStatus = 'ready' | 'uploading' | 'uploaded' | 'queued' | 'processing' | 'success' | 'failed' | 'canceled';
interface FileRow {
  id: string; file: File; path: string; password: string; showPassword: boolean; pageRange: string;
  status: RowStatus; error: string; validation: string | null;
  itemId?: string; batchId?: string;
  outputName?: string; result?: Blob; request?: Record<string, unknown>; field?: string;
}
const rows = ref<FileRow[]>([]);
const selectedId = ref('');
const selected = computed(() => rows.value.find((row) => row.id === selectedId.value) ?? rows.value[0]);
const input = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const uploadMenu = ref<HTMLDetailsElement>();
onClickOutside(uploadMenu, () => {
  if (uploadMenu.value) uploadMenu.value.open = false;
});
const imageInput = ref<HTMLInputElement>();
const insertInput = ref<HTMLInputElement>();
const iccInput = ref<HTMLInputElement>();
const parameter = ref(defaultParameter());
const password = ref(''); // ParamForm compatibility: opening passwords live on rows.
const isCsvMerge = ref('0');
const watermarkImageFile = shallowRef<File | null>(null);
const settingsTouched = ref(false);
const insertTargetFile = shallowRef<File | null>(null);
const iccProfileFile = shallowRef<File | null>(null);
const stampKind = computed(() => props.toolSlug.includes('bates') ? 'bates' as const : 'headers-footers' as const);
const stamp = ref(defaultStampParameter(stampKind.value));
const isStamp = computed(() => ['add-headers-footers', 'add-bates'].includes(props.toolSlug));
const isRemoval = computed(() => ['remove-headers-footers', 'remove-bates'].includes(props.toolSlug));
const hasFilePageRange = computed(() => props.toType === 'merge');
const hasSettings = computed(() => {
  if (hasFilePageRange.value || isRemoval.value) return false;
  if (props.toType !== 'pdf' || props.fromType === 'pdf') return true;
  const features = CONVERSION_FEATURES[`${props.fromType}/${props.toType}`] ?? {};
  // Opening passwords already belong to the file rows, not the settings panel.
  return Object.entries(features).some(([name, enabled]) => name !== 'password' && enabled);
});
const running = ref(false);
const readingFolder = ref(false);
const downloading = ref(false);
const started = ref(false);
const pollFailed = ref(false);
const errorText = ref('');
const expanded = ref(false);
const filter = ref<'all' | 'success' | 'failure'>('all');
const dragDepth = ref(0);
const draggingId = ref('');
const splitMode = ref<SplitMode>('custom');
const splitValue = ref('');
const splitCount = ref(1);
const splitSeparator = ref('_');
const activeBatch = ref('');
let alive = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let releaseWait: (() => void) | undefined;
const abortController = new AbortController();
const locked = computed(() => running.value || started.value);
const completed = computed(() => started.value && !running.value && !pollFailed.value);
const filesDisabled = computed(() => running.value || downloading.value || pollFailed.value);
const isTrialLicense = computed(() => window.COMPDF_CONFIG?.isFormalLicense === false);
const upgradeUrl = computed(() => window.COMPDF_CONFIG?.contactUrl || 'https://www.compdf.com/contact-sales');
const globalError = computed(() => errorText.value && (pollFailed.value || !rows.value.some((row) => row.error === errorText.value)) ? errorText.value : '');
const ruleErrors = computed(() => new Map(rows.value.map((row) => [row.id, rowRuleError(row)])));
const successes = computed(() => rows.value.filter((row) => row.status === 'success'));
const failures = computed(() => rows.value.filter((row) => ['failed', 'canceled'].includes(row.status) || ruleErrors.value.get(row.id)));
const ready = computed(() => rows.value.filter((row) => !ruleErrors.value.get(row.id) && row.status === 'ready'));
const filteredRows = computed(() => filter.value === 'success' ? successes.value : filter.value === 'failure' ? failures.value : rows.value);
const visibleRows = computed(() => started.value || expanded.value ? filteredRows.value : filteredRows.value.slice(0, 5));
const processed = computed(() => rows.value.filter((row) => ['success', 'failed', 'canceled'].includes(row.status) || row.validation).length);
const progress = computed(() => rows.value.length ? Math.round(processed.value / rows.value.length * 100) : 0);
const currentFile = computed(() => rows.value.find((row) => ['uploading', 'processing'].includes(row.status))?.file.name);
const actionLabel = computed(() => props.toType === 'split' ? t('batchTools.startSplit') : props.endpoint.kind === 'pdf' && props.toType !== 'pdfa' ? t(toolI18nKey(props.toolSlug)) : t('batchTools.startConversion'));

watch([running, started, () => rows.value.length], () => emit('updateStatus', running.value ? 'uploading' : started.value ? 'success' : rows.value.length ? 'await' : ''));

async function localError(error: unknown): Promise<string> {
  const apiError = await toApiError(error);
  const key = apiErrorTranslationKey(apiError, props.endpoint.kind === 'pdf' ? 'pdf' : 'conversion');
  return key ? t(`pdfToolDetail.upload.errors.apiCodes.${key}`) : apiError.message;
}

async function addFiles(files: PickedFile[]) {
  if (filesDisabled.value || !alive) return;
  const rejectedByType = files.filter((picked) => {
    const validation = fileValidationKey(picked.file, props.accept);
    return validation === 'batchTools.unsupportedFormat';
  });
  const acceptedFiles = files.filter((picked) => !rejectedByType.includes(picked));
  if (completed.value && acceptedFiles.length) editAgain();
  errorText.value = !files.length
    ? t('batchTools.folderEmpty')
    : rejectedByType.length
      ? t('batchTools.unsupportedFormat')
      : '';
  for (const picked of acceptedFiles) {
    // Distinct folder paths are distinct files, even if their basenames match.
    if (rows.value.some((row) => row.path === picked.path && row.file.size === picked.file.size && row.file.lastModified === picked.file.lastModified)) continue;
    const row: FileRow = { id: randomUuid(), ...picked, password: '', showPassword: false, pageRange: '', status: 'ready', error: '', validation: fileValidationKey(picked.file, props.accept) };
    rows.value.push(row);
    if (!selectedId.value) selectedId.value = row.id;
  }
}

async function changeFiles(event: Event) {
  const target = event.target as HTMLInputElement;
  const files = Array.from(target.files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  target.value = '';
  await addFiles(files);
}
async function drop(event: DragEvent) {
  dragDepth.value = 0;
  if (filesDisabled.value || !event.dataTransfer || draggingId.value) return;
  readingFolder.value = true;
  try { await addFiles(await droppedFiles(event.dataTransfer)); }
  catch { errorText.value = t('batchTools.readFolderFailed'); }
  finally { readingFolder.value = false; }
}
function removeRow(id: string) {
  if (running.value || downloading.value || pollFailed.value) return;
  if (props.toType === 'merge' && started.value) return;
  rows.value = rows.value.filter((row) => row.id !== id);
  if (!rows.value.length) clearList();
}
function clearList() {
  if (running.value || downloading.value || pollFailed.value) return;
  rows.value = []; selectedId.value = ''; started.value = false; pollFailed.value = false; settingsTouched.value = false;
  activeBatch.value = ''; errorText.value = ''; filter.value = 'all';
}
function moveRow(id: string, offset: number) {
  if (locked.value) return;
  const index = rows.value.findIndex((row) => row.id === id);
  const next = index + offset;
  if (index < 0 || next < 0 || next >= rows.value.length) return;
  const [row] = rows.value.splice(index, 1);
  rows.value.splice(next, 0, row!);
}
function dropRow(id: string) {
  const from = rows.value.findIndex((row) => row.id === draggingId.value);
  const to = rows.value.findIndex((row) => row.id === id);
  if (from >= 0 && to >= 0) moveRow(draggingId.value, to - from);
  draggingId.value = '';
}
function editAgain() {
  if (running.value || downloading.value || pollFailed.value) return;
  started.value = false; activeBatch.value = ''; pollFailed.value = false; filter.value = 'all'; settingsTouched.value = false;
  rows.value.forEach((row) => Object.assign(row, { status: 'ready', itemId: undefined, batchId: undefined, result: undefined, request: undefined, outputName: undefined, error: '' }));
}

const validationKey = computed(() => {
  if (isStamp.value) return stampValidationKey(stampKind.value, stamp.value);
  if (props.toType === 'addWatermark') {
    if (parsePages(normalizedFileRange(parameter.value.pageRanges)) === null) return 'batchTools.stamp.errors.pages';
    if (parameter.value.watermarkType === 'text' && parameter.value.watermarkFontColor && !/^#[\da-f]{6}$/i.test(parameter.value.watermarkFontColor)) return 'batchTools.stamp.errors.color';
    return watermarkValidationKey(parameter.value, watermarkImageFile.value);
  }
  if (props.toType === 'compress') return compressImageQualityValidationKey(parameter.value);
  if (props.toType === 'delete') return deletePageRangeValidationKey(parameter.value.pageRanges);
  if (props.toType === 'encrypt') return encryptPasswordValidationKey(parameter.value.encryptUserPassword);
  if (props.toType === 'pdfa' && !iccProfileFile.value) return 'pdfToolDetail.upload.errors.iccProfileRequired';
  if (props.toType === 'insert' && parameter.value.insertActionType === 'FROM_PDF') return !insertTargetFile.value ? 'pdfToolDetail.upload.errors.insertFileCount' : insertSourcePageRangeValidationKey(parameter.value.sourcePages);
  if (props.fromType === 'pdf' && ['png', 'jpg', 'img'].includes(props.toType)) return imageDpiValidationKey(parameter.value.imgDpi);
  if (props.toType === 'merge' && ready.value.length < 2) return 'pdfToolDetail.upload.errors.mergeRequired';
  if (props.toType === 'split' && (splitMode.value === 'custom' ? !splitCustomRanges(splitValue.value) : !Number.isInteger(splitCount.value) || splitCount.value < 1)) return 'batchTools.splitInvalid';
  return null;
});

function rowRuleError(row: FileRow): string | null {
  if (row.validation) return row.validation;
  if (hasFilePageRange.value) {
    const range = normalizedFileRange(row.pageRange);
    if (parsePages(range) === null) return 'batchTools.stamp.errors.pages';
  }
  return null;
}
const canStart = computed(() => !locked.value && !readingFolder.value && !validationKey.value && ready.value.some((row) => !rowRuleError(row)));
const effectiveEndpoint = computed<Endpoint>(() => props.toType === 'insert' && parameter.value.insertActionType === 'BLANK' ? { kind: 'pdf', op: 'insert-blank' } : props.endpoint);
const useSync = computed(() => props.toType === 'split' || props.toType === 'encrypt' || (props.toType === 'addWatermark' && parameter.value.watermarkType === 'image') || !buildBatchRequest(effectiveEndpoint.value));

function normalizedFileRange(value: string): string {
  return value.trim().toLowerCase().replace(/[、，]/g, ',').replace(/\s*([,-])\s*/g, '$1') || 'all';
}

function requestFor(row: FileRow): { field: string; payload: Record<string, unknown> } {
  if (isStamp.value) return { field: 'request', payload: buildStampRequest(stampKind.value, stamp.value) };
  // Removal endpoints operate on all pages by default and accept no page range.
  if (isRemoval.value) return { field: 'request', payload: {} };
  const config = { ...parameter.value, mergePasswords: ready.value.map((item) => item.password), mergeFilePageRanges: ready.value.map((item) => normalizedFileRange(item.pageRange)) };
  if (props.toType === 'addWatermark') config.pageRanges = normalizedFileRange(config.pageRanges);
  const result = buildRequest({ fromType: props.fromType, toType: props.toType, parameter: config, password: '', files: props.toType === 'merge' ? ready.value.map((item) => item.file) : [row.file], isCsvMerge: isCsvMerge.value === '1', watermarkImageFile: watermarkImageFile.value ?? undefined, insertTargetFile: insertTargetFile.value ?? undefined });
  if (props.toType === 'split') {
    if (splitMode.value === 'custom') result.payload.ranges = splitCustomRanges(splitValue.value);
    else {
      delete result.payload.ranges;
      result.payload.splitMode = splitMode.value;
      result.payload.splitCount = splitCount.value;
    }
  }
  return result;
}

async function runSync(row: FileRow, mergeRows?: FileRow[]) {
  row.status = 'processing'; row.error = '';
  const payload = { ...row.request };
  const ep = effectiveEndpoint.value;
  if (ep.kind === 'pdf') {
    if (props.toType === 'merge') payload.passwords = mergeRows!.map((item) => item.password || null);
    else if (ep.op === 'insert-from-pdf') payload.targetPassword = row.password;
    else if (row.password) payload.password = row.password;
  }
  const form = new FormData();
  if (mergeRows) mergeRows.forEach((item) => form.append('files', item.file));
  else form.append('file', row.file);
  if (ep.kind === 'pdf' && ep.op === 'insert-from-pdf' && insertTargetFile.value) form.append('insertFile', insertTargetFile.value);
  if (watermarkImageFile.value && props.toType === 'addWatermark') form.append('imageFile', watermarkImageFile.value);
  if (iccProfileFile.value && props.toType === 'pdfa') form.append('iccFile', iccProfileFile.value);
  form.append(row.field ?? 'request', JSON.stringify(payload));
  if (ep.kind !== 'pdf' && row.password) form.append('password', row.password);
  const url = ep.kind === 'pdf' ? `/process/pdf/${ep.op}` : ep.kind === 'convert-target' ? `/process/pdf/${ep.target}` : `/process/${ep.type}`;
  try {
    const response = await apiClient.post<Blob>(url, form, { responseType: 'blob', signal: abortController.signal });
    if (!alive) return;
    const blob = props.toType === 'split' ? await nameSplitOutputs(response.data, row.file.name, splitSeparator.value) : response.data;
    const filename = parseContentDispositionFilename(response.headers['content-disposition']) ?? row.file.name.replace(/\.[^.]+$/, props.toType === 'split' ? '.zip' : '.pdf');
    for (const item of mergeRows ?? [row]) Object.assign(item, { status: 'success', result: blob, outputName: filename, error: '' });
  } catch (error) {
    const message = await localError(error);
    for (const item of mergeRows ?? [row]) Object.assign(item, { status: 'failed', error: message });
  }
}

function applyBatch(batch: BatchInfo) {
  for (const item of batch.items) {
    const row = rows.value.find((file) => file.itemId === item.itemId);
    if (!row) continue;
    row.status = item.status; row.outputName = item.outputName;
    const key = item.failureCode ? apiErrorTranslationKey({ code: Number(item.failureCode), errorCode: item.failureCode, message: item.failureReason ?? '' }, props.endpoint.kind === 'pdf' ? 'pdf' : 'conversion') : null;
    row.error = item.failureReason ? (key ? t(`pdfToolDetail.upload.errors.apiCodes.${key}`) : item.failureReason) : '';
  }
}
function waitForPoll() {
  return new Promise<void>((resolve) => { releaseWait = resolve; timer = setTimeout(resolve, 1000); });
}
async function poll() {
  pollFailed.value = false;
  try {
    while (alive && activeBatch.value) {
      const batch = await batchApi.status(activeBatch.value);
      if (!alive) return;
      applyBatch(batch);
      if (['success', 'partial_success', 'failed', 'canceled'].includes(batch.status)) return;
      // Recover an uncertain commit response without creating or reuploading a batch.
      if (batch.status === 'draft') await batchApi.submit(batch.batchId);
      await waitForPoll();
    }
  } catch (error) { pollFailed.value = true; errorText.value = `${t('batchTools.pollingFailed')} ${await localError(error)}`; }
  finally { if (alive) running.value = false; }
}
async function resumePolling() {
  if (running.value) return;
  running.value = true; errorText.value = ''; await poll();
}

async function start() {
  if (!canStart.value) return;
  errorText.value = ''; started.value = true; running.value = true; filter.value = 'all';
  const candidates = rows.value.filter((row) => row.status === 'ready');
  for (const row of candidates) {
    const error = rowRuleError(row);
    if (error) { row.status = 'failed'; row.error = t(error); }
    else { const request = requestFor(row); row.request = request.payload; row.field = request.field; }
  }
  const valid = candidates.filter((row) => row.status === 'ready');
  try {
    if (!valid.length) return;
    if (useSync.value) {
      if (props.toType === 'merge') await runSync(valid[0]!, valid);
      else for (const row of valid) { if (!alive) break; await runSync(row); }
      return;
    }
    const shared = { ...valid[0]!.request };
    // Let each SDK output inherit its own source filename, not the first file's.
    if (!parameter.value.outputFileName.trim()) { delete shared.outputFileName; delete shared.zipFileName; }
    const request = buildBatchRequest(effectiveEndpoint.value, shared, randomUuid())!;
    const batch = await batchApi.create(request);
    if (!alive) return;
    activeBatch.value = batch.batchId;
    for (const row of valid) {
      if (!alive) return;
      row.status = 'uploading';
      try {
        const item = row.path !== row.file.name
          ? await batchApi.upload(batch.batchId, row.file, row.password, row.path)
          : await batchApi.upload(batch.batchId, row.file, row.password);
        row.itemId = item.itemId; row.batchId = batch.batchId; row.status = item.status;
      } catch (error) { row.status = 'failed'; row.error = await localError(error); }
    }
    if (!valid.some((row) => row.itemId)) return;
    if (!alive) return;
    await batchApi.submit(batch.batchId);
    await poll();
  } catch (error) {
    errorText.value = await localError(error);
    if (activeBatch.value && valid.some((row) => row.itemId)) pollFailed.value = true;
    else for (const row of valid) if (row.status === 'ready') { row.status = 'failed'; row.error = errorText.value; }
  } finally { if (alive) running.value = false; }
}

async function retryRows(targets: FileRow[]) {
  if (running.value || pollFailed.value || !targets.length) return;
  running.value = true; errorText.value = '';
  try {
    if (props.toType === 'merge') {
      const originalInputs = rows.value.filter((row) => row.request);
      if (originalInputs.length >= 2) await runSync(originalInputs[0]!, originalInputs);
      return;
    }
    let remoteRetry = false;
    for (const row of targets) {
      if (!alive) break;
      if (row.itemId) {
        try { await batchApi.retry(row.itemId, { password: row.password }); row.status = 'queued'; row.error = ''; activeBatch.value = row.batchId!; remoteRetry = true; }
        catch (error) {
          row.error = await localError(error);
          // The retry may have been accepted before its response was lost.
          // Reconcile this batch instead of stranding an already-running item.
          activeBatch.value = row.batchId!;
          remoteRetry = true;
        }
      } else {
        const validation = rowRuleError(row);
        if (validation) { row.error = t(validation); continue; }
        if (!row.request) {
          const request = requestFor(row);
          row.request = request.payload;
          row.field = request.field;
        }
        await runSync(row);
      }
    }
    if (remoteRetry) await poll();
  } finally { if (alive) running.value = false; }
}

async function resultFor(row: FileRow): Promise<Blob> {
  if (row.result) return row.result;
  const response: AxiosResponse<Blob> = await batchApi.downloadItem(row.itemId!);
  return response.data;
}
async function download(row: FileRow) {
  try {
    const snapshot = { ...row };
    const blob = await resultFor(snapshot);
    if (alive) saveBlob(blob, snapshot.outputName ?? snapshot.file.name);
  }
  catch (error) { errorText.value = await localError(error); }
}
async function downloadAll() {
  if (downloading.value || !successes.value.length) return;
  downloading.value = true;
  try {
    if (props.toType === 'merge') {
      const row = { ...successes.value[0]! };
      const blob = await resultFor(row);
      if (alive) saveBlob(blob, row.outputName ?? row.file.name.replace(/\.[^.]+$/, '.pdf'));
      return;
    }
    const files: Record<string, Uint8Array> = Object.create(null);
    const unique = successes.value.map((row) => ({ ...row }));
    for (const [index, row] of unique.entries()) {
      const directory = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/') + 1) : '';
      let name = (directory + (row.outputName ?? row.file.name)).split(/[\\/]/).filter((part) => part && part !== '.' && part !== '..').join('/');
      if (files[name]) name = `${index + 1}-${name}`;
      files[name] = new Uint8Array(await (await resultFor(row)).arrayBuffer());
      if (!alive) return;
    }
    const archive = await zipFiles(files);
    if (alive) saveBlob(archive, `${props.toolSlug}-results.zip`);
  } catch (error) { errorText.value = await localError(error); }
  finally { downloading.value = false; }
}

function sizeLabel(bytes: number) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function rowStatus(row: FileRow) { return t(`batchTools.${row.validation ? 'invalid' : row.status === 'success' ? 'processed' : row.status === 'failed' || row.status === 'canceled' ? 'processingFailed' : row.status === 'ready' ? 'ready' : row.status === 'uploading' ? 'uploading' : row.status === 'processing' ? 'processing' : 'waiting'}`); }
function rowError(row: FileRow): string {
  const key = ruleErrors.value.get(row.id);
  return row.error || (key ? t(key) : '');
}
async function primaryAction() {
  if (filesDisabled.value) return;
  if (!started.value) { await start(); return; }
  const retryable = failures.value.filter(canRetryRow);
  if (retryable.length) await retryRows(retryable);
  else if (!failures.value.length) { editAgain(); await start(); }
}
function canRetryRow(row: FileRow): boolean {
  return row.status === 'failed' && (!!row.itemId || !!row.request);
}
function pickAuxiliary(event: Event, kind: 'image' | 'insert' | 'icc') {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0] ?? null; target.value = '';
  if (locked.value) return;
  if (kind === 'image') watermarkImageFile.value = file;
  else if (kind === 'insert') insertTargetFile.value = file;
  else iccProfileFile.value = file;
}
onBeforeUnmount(() => { alive = false; abortController.abort(); clearTimeout(timer); releaseWait?.(); });
</script>

<template>
  <TooltipProvider :delay-duration="150">
    <section class="batch-panel" :class="{ 'is-processing': running, 'is-completed': completed }"
      :aria-busy="running || readingFolder" @dragenter.prevent="!filesDisabled && !draggingId && dragDepth++"
      @dragleave.prevent="dragDepth = Math.max(0, dragDepth - 1)" @dragover.prevent @drop.prevent="drop">
      <input ref="input" name="files" class="hidden-input" type="file" :accept="accept" multiple
        :disabled="filesDisabled" @change="changeFiles">
        <input ref="folderInput" name="folder" class="hidden-input" type="file" webkitdirectory multiple
          :disabled="filesDisabled" @change="changeFiles">
          <input ref="imageInput" class="hidden-input" type="file" accept="image/*"
            @change="pickAuxiliary($event, 'image')">
            <input ref="insertInput" class="hidden-input" type="file" accept=".pdf"
              @change="pickAuxiliary($event, 'insert')">
              <input ref="iccInput" class="hidden-input" type="file" accept=".icc,.icm"
                @change="pickAuxiliary($event, 'icc')">

                <div v-if="!rows.length" class="empty-upload" :class="{ 'drag-active': dragDepth > 0 }">
                  <div class="upload-actions">
                    <button type="button" class="primary" :disabled="readingFolder" @click="input?.click()">
                      <UploadIcon />{{ t('batchTools.addFiles') }}
                    </button>
                    <button type="button" class="outline" :disabled="readingFolder" @click="folderInput?.click()">
                      <FolderIcon />{{ t('batchTools.uploadFolder') }}
                    </button>
                  </div>
                  <p>{{ readingFolder ? t('batchTools.processing') : t('batchTools.dropHint') }}</p>
                  <p class="formats">{{ t('batchTools.supportedFormats', { formats: accept.split(',').join(', ') }) }}
                  </p>
                </div>

                <template v-else>
                  <div v-if="dragDepth && !filesDisabled" class="drop-overlay">{{ t('batchTools.dropHint') }}</div>
                  <div class="workspace-grid"
                    :class="{ 'without-settings': !hasSettings, 'initial-file-ranges': hasFilePageRange && !started }">
                    <div class="documents-column">
                      <section class="documents card">
                        <div class="document-heading">
                          <h2>{{ t('batchTools.documentList') }}</h2>
                          <div v-if="completed" class="result-actions">
                            <button type="button" class="small-button" :disabled="filesDisabled" @click="editAgain">
                              <ResetIcon />{{ t('batchTools.resetParameters') }}
                            </button>
                            <button type="button" class="small-button result-download"
                              :disabled="filesDisabled || !successes.length" @click="downloadAll">
                              <DownloadIcon />{{ t('batchTools.downloadAll') }}
                            </button>
                          </div>
                        </div>
                        <div v-if="completed" class="result-summary" aria-live="polite">
                          <div class="summary-card total"><span>{{ t('batchTools.totalFiles') }}</span><strong>{{
                            rows.length }}</strong></div>
                          <div class="summary-card successful"><span>{{ t('batchTools.success') }}</span><strong>{{
                            successes.length }}</strong></div>
                          <div class="summary-card failure"><span>{{ t('batchTools.failure') }}</span><strong>{{
                            failures.length }}</strong></div>
                        </div>
                        <div v-if="completed && isTrialLicense" class="trial-banner">
                          <WarningIcon />
                          <p>{{ t('batchTools.trialLimit') }}</p><a :href="upgradeUrl" target="_blank"
                            rel="noopener noreferrer">{{ t('pdfToolDetail.upload.upgradeNow') }}</a>
                        </div>
                        <div class="list-toolbar">
                          <div v-if="started" class="filters" :aria-label="t('batchTools.status')">
                            <button v-for="tab in (['all', 'success', 'failure'] as const)" :key="tab" type="button"
                              :class="{ active: filter === tab }" :aria-pressed="filter === tab"
                              @click="filter = tab">{{ t(`batchTools.${tab}`) }} <span>{{ tab === 'all' ? rows.length :
                                tab === 'success' ? successes.length : failures.length }}</span></button>
                          </div>
                          <div class="list-actions">
                            <details ref="uploadMenu" class="add-menu" :class="{ disabled: filesDisabled }">
                              <summary :aria-disabled="filesDisabled" @click="filesDisabled && $event.preventDefault()">
                                <UploadOutlineIcon />{{ t('batchTools.uploadFiles') }}
                                <ChevronIcon />
                              </summary>
                              <div><button type="button" :disabled="filesDisabled" @click="input?.click()">{{
                                t('batchTools.addFiles') }}</button><button type="button" :disabled="filesDisabled"
                                  @click="folderInput?.click()">{{ t('batchTools.uploadFolder') }}</button></div>
                            </details>
                            <button type="button" class="small-button" :disabled="running || downloading || pollFailed"
                              @click="clearList">
                              <ClearIcon />{{ t('batchTools.clearList') }}
                            </button>
                          </div>
                        </div>
                        <div v-if="running || pollFailed" class="progress-panel" aria-live="polite">
                          <img :src="spinnerUrl" class="processing-spinner" alt="">
                          <div class="progress-heading"><span>{{ pollFailed ? t('batchTools.pollingFailed') :
                            t('batchTools.processing') }}</span><span>{{ processed }}/{{ rows.length }}</span></div>
                          <div class="progress-track"><progress :value="progress" max="100"
                              :aria-label="t('batchTools.processing')" /><span>{{ progress }}%</span></div>
                          <p v-if="currentFile">{{ t('batchTools.currentFile') }} {{ currentFile }}</p>
                        </div>
                        <div class="table-scroll">
                          <table :class="{ 'result-table': started, 'file-range-table': hasFilePageRange }">
                            <thead>
                              <tr>
                                <th class="order-col"></th>
                                <th>{{ t('batchTools.fileName') }}</th>
                                <th>{{ t('batchTools.size') }}</th>
                                <th>{{ t('batchTools.password') }}</th>
                                <th v-if="hasFilePageRange" class="page-range-cell">{{
                                  t('pdfToolDetail.upload.settings.pageRange') }}</th>
                                <th v-if="started" class="status-cell">{{ t('batchTools.status') }}</th>
                                <th class="actions-cell">{{ t('batchTools.actions') }}</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr v-for="row in visibleRows" :key="row.id"
                                :class="{ failed: row.status === 'failed' || ruleErrors.get(row.id) }"
                                @drop.stop.prevent="dropRow(row.id)">
                                <td class="order-col"><button type="button" class="drag-handle" :draggable="!locked"
                                    :disabled="locked"
                                    :aria-label="`${t('batchTools.moveUp')} / ${t('batchTools.moveDown')}: ${row.file.name}`"
                                    @dragstart.stop="draggingId = row.id" @dragend="draggingId = ''"
                                    @keydown.up.prevent="moveRow(row.id, -1)"
                                    @keydown.down.prevent="moveRow(row.id, 1)">
                                    <DragHandleIcon />
                                  </button></td>
                                <td class="name-cell"><button type="button" class="file-name" :title="row.path"
                                    :aria-pressed="selected?.id === row.id" @click="selectedId = row.id">
                                    <DocumentIcon /><span>{{ row.file.name }}</span>
                                  </button><small v-if="!started && (ruleErrors.get(row.id) || row.error)"
                                    class="error">{{ row.error || t(ruleErrors.get(row.id)!) }}</small></td>
                                <td class="size-cell">{{ sizeLabel(row.file.size) }}</td>
                                <td>
                                  <div class="password-field">
                                    <LockIcon /><input v-model="row.password"
                                      :type="row.showPassword ? 'text' : 'password'" maxlength="512" autocomplete="off"
                                      :aria-label="`${t('batchTools.password')}: ${row.file.name}`"
                                      :placeholder="t('batchTools.passwordPlaceholder')"
                                      :disabled="running || row.status === 'success'"><button
                                        type="button" :disabled="running"
                                        :aria-label="`${t('batchTools.password')}: ${row.file.name}`"
                                        :aria-pressed="row.showPassword" @click="row.showPassword = !row.showPassword">
                                        <EyeOffIcon />
                                      </button>
                                  </div>
                                </td>
                                <td v-if="hasFilePageRange" class="page-range-cell">
                                  <input v-model="row.pageRange" class="file-page-range" type="text"
                                    :aria-label="`${t('pdfToolDetail.upload.settings.pageRange')}: ${row.file.name}`"
                                    :aria-invalid="!!ruleErrors.get(row.id)"
                                    :aria-describedby="ruleErrors.get(row.id) ? `range-error-${row.id}` : undefined"
                                    :placeholder="t('batchTools.stamp.allPages')" :disabled="locked">
                                    <span v-if="ruleErrors.get(row.id)" :id="`range-error-${row.id}`" class="sr-only">{{
                                      t(ruleErrors.get(row.id)!) }}</span>
                                </td>
                                <td v-if="started" class="status-cell">
                                  <Tooltip>
                                    <TooltipTrigger as-child><button type="button" class="status-badge"
                                        :class="row.status" :aria-label="rowError(row) || rowStatus(row)">
                                        <SuccessIcon v-if="row.status === 'success'" />
                                        <FailedIcon
                                          v-else-if="row.status === 'failed' || row.status === 'canceled' || row.validation" />
                                        <WaitingIcon v-else /><span class="sr-only">{{ rowStatus(row) }} {{
                                          rowError(row) }}</span>
                                      </button></TooltipTrigger>
                                    <TooltipContent>{{ rowError(row) || rowStatus(row) }}</TooltipContent>
                                  </Tooltip>
                                </td>
                                <td>
                                  <div class="row-actions"><button v-if="row.status === 'success' && toType !== 'merge'" type="button"
                                      :title="t('batchTools.download')" :aria-label="t('batchTools.download')"
                                      @click="download(row)">
                                      <DownloadIcon />
                                    </button><button v-if="canRetryRow(row)" type="button"
                                      :disabled="running || pollFailed" :title="t('batchTools.retry')"
                                      :aria-label="t('batchTools.retry')" @click="retryRows([row])">
                                      <RetryIcon />
                                    </button><button v-if="!(toType === 'merge' && started)" type="button"
                                      :disabled="running || downloading || pollFailed || (toType === 'merge' && started)"
                                      :title="t('batchTools.delete')" :aria-label="t('batchTools.delete')"
                                      @click="removeRow(row.id)">
                                      <DeleteIcon />
                                    </button></div>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        <div v-if="!started && (rows.length > 5 || failures.length)" class="list-footer">
                          <button v-if="!started && rows.length > 5" type="button" class="text-button"
                            @click="expanded = !expanded">{{ t(expanded ? 'batchTools.collapseList' :
                              'batchTools.expandAll') }}</button>
                          <button v-if="!started && failures.length" type="button" class="text-button"
                            @click="rows = rows.filter(row => !ruleErrors.get(row.id))">{{ t('batchTools.removeInvalid')
                            }}</button>
                        </div>
                      </section>
                    </div>

                    <aside v-if="hasSettings" class="settings card" :class="{ 'settings-locked': locked }">
                      <h2>{{ t('batchTools.settings') }}</h2>
                      <fieldset :disabled="locked" @input="settingsTouched = true" @change="settingsTouched = true">
                        <StampSettings v-if="isStamp" v-model="stamp" :kind="stampKind" :disabled="locked" />
                        <p v-else-if="isRemoval" class="removal-note">{{ t('batchTools.wholeDocumentRemoval') }}</p>
                        <SplitSettings v-else-if="toType === 'split'" v-model:mode="splitMode" v-model:ranges="splitValue"
                          v-model:count="splitCount" v-model:separator="splitSeparator"
                          :filename="selected?.file.name" :disabled="locked" />
                        <WatermarkSettings v-else-if="toType === 'addWatermark'" v-model:parameter="parameter"
                          v-model:image-file="watermarkImageFile" :disabled="locked" @pick-image="imageInput?.click()"
                          />
                        <ParamForm v-else :from-type="fromType" :to-type="toType" :files="rows.map(row => row.file)"
                          :converting="locked" batch v-model:parameter="parameter" v-model:password="password"
                          v-model:is-csv-merge="isCsvMerge" v-model:watermark-image-file="watermarkImageFile"
                          v-model:insert-target-file="insertTargetFile" v-model:icc-profile-file="iccProfileFile"
                          @pick-watermark-image="imageInput?.click()" @pick-insert-target="insertInput?.click()"
                          @pick-icc-profile="iccInput?.click()"
                          @drop-icc-profile="(file) => { if (!locked) iccProfileFile = file; }" />
                      </fieldset>
                      <p v-if="validationKey && settingsTouched && !started && !isStamp"
                        class="error">{{ t(validationKey) }}</p>
                    </aside>
                  </div>
                  <div class="main-actions">
                    <button type="button" class="primary start-button"
                      :disabled="filesDisabled || (!started && !canStart)" @click="primaryAction">{{ actionLabel
                      }}</button>
                  </div>
                </template>
                <p v-if="globalError" role="alert" class="error panel-error">{{ globalError }}</p>
                <button v-if="pollFailed" type="button" class="outline" :disabled="running" @click="resumePolling">{{
                  t('batchTools.resumePolling') }}</button>
    </section>
  </TooltipProvider>
</template>

<style scoped>
.batch-panel {
  position: relative;
  width: 100%;
  color: #0c131f;
  font-size: 14px;
}

.hidden-input {
  display: none;
}

button,
input,
select {
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  opacity: .45;
  cursor: not-allowed;
}

button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 2px solid #396ffa;
  outline-offset: 2px;
}

.primary,
.outline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border: 1px solid #396ffa;
  border-radius: 6px;
  padding: 8px 24px;
  min-height: 40px;
  font-size: 16px;
  line-height: 24px;
}

.primary {
  background: #396ffa;
  color: #fff;
}

.outline {
  background: #fff;
  color: #396ffa;
}

.primary svg,
.outline svg {
  width: 18px;
  height: 18px;
  flex: none;
}

.empty-upload {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: min(800px, calc(100vh - 240px));
  padding: 48px 16px;
  background: #fff;
  border: 1px dashed #dcdde1;
  text-align: center;
}

.empty-upload.drag-active {
  background: #f5f7ff;
  border-color: #618cfb;
}

.upload-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 16px;
}

.empty-upload p {
  margin: 8px 0 0;
  color: #6d727a;
  line-height: 22px;
}

.empty-upload .formats {
  color: #9da0a6;
  font-size: 12px;
}

.drop-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  z-index: 20;
  background: #f5f7ffed;
  border: 2px dashed #618cfb;
  pointer-events: none;
}

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.76fr) minmax(320px, 1fr);
  gap: 16px;
  align-items: start;
}

.workspace-grid.without-settings {
  grid-template-columns: minmax(0, 1fr);
}

.file-range-table th:nth-child(2) {
  width: 29%;
}

.initial-file-ranges .documents {
  min-height: min(730px, max(400px, calc(100vh - 300px)));
}

.file-range-table th:nth-child(3) {
  width: 5%;
}

.file-range-table th:nth-child(4),
.file-range-table .page-range-cell {
  width: 28%;
}

.file-range-table.result-table th:nth-child(2) {
  width: 25%;
}

.file-range-table.result-table th:nth-child(4),
.file-range-table.result-table .page-range-cell {
  width: 24%;
}

.file-page-range {
  width: 100%;
  height: 26px;
  min-width: 0;
  border: 1px solid #dcdde1;
  border-radius: 3px;
  background: #fff;
  padding: 2px 8px;
  font-size: 12px;
}

.file-page-range[aria-invalid="true"] {
  border-color: #d44040;
}

.documents-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.card {
  min-width: 0;
  padding: 16px;
  border: 1px solid #dcdde1;
  border-radius: 6px;
  background: #fff;
}

h2 {
  margin: 0 0 24px;
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
}

.document-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 24px;
}

.documents h2 {
  margin: 0;
}

.result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}

.small-button.result-download {
  border-color: #396ffa;
  background: #396ffa;
  color: #fff;
}

.result-download :deep(path) {
  fill: currentColor;
}

.result-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 24px;
}

.summary-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  border: 1px solid #dce5ff;
  border-top: 3px solid #396ffa;
  border-radius: 4px;
  padding: 16px 20px;
}

.summary-card span {
  color: #777d88;
  font-size: 12px;
  line-height: 20px;
}

.summary-card strong {
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  color: #396ffa;
}

.summary-card.successful {
  border-color: #c9efdc;
  border-top-color: #67d1a0;
}

.summary-card.successful strong {
  color: #67d1a0;
}

.summary-card.failure {
  border-color: #f6cdcd;
  border-top-color: #d44040;
}

.summary-card.failure strong {
  color: #d44040;
}

.trial-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border: 1px solid #fbd7aa;
  border-radius: 4px;
  background: #fef3e6;
  color: #f28909;
  margin-bottom: 24px;
  font-size: 12px;
  line-height: 20px;
}

.trial-banner>svg {
  width: 18px;
  height: 18px;
  flex: none;
}

.trial-banner p {
  margin: 0;
  flex: 1;
  margin-right: 8px;
}

.trial-banner a {
  flex: none;
  padding: 4px 8px;
  border-radius: 3px;
  background: #f5a13a;
  color: #fff;
  text-decoration: none;
}

.add-menu.disabled summary {
  opacity: .45;
  cursor: not-allowed;
}

.result-table th:nth-child(2) {
  width: 33%;
}

.result-table th:nth-child(3) {
  width: 8%;
}

.result-table .status-cell {
  width: 72px;
  text-align: center;
}

.result-table .actions-cell {
  width: 96px;
  text-align: center;
}

.result-table .row-actions {
  justify-content: flex-end;
  gap: 16px;
}

.is-processing .primary.start-button:disabled {
  opacity: 1;
  background: #b0c5fd;
  border-color: #b0c5fd;
}

.settings-locked {
  opacity: .5;
}

.settings-locked :deep(:disabled) {
  opacity: 1;
}

.is-completed .workspace-grid {
  align-items: stretch;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  padding: 2px;
  background: none;
}

.status-badge svg {
  display: block;
  width: 16px;
  height: 16px;
}

.list-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 24px;
}

.list-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.filters {
  display: flex;
  background: #f5f7ff;
  border-radius: 3px;
}

.filters button {
  border: 1px solid transparent;
  padding: 5px 12px;
  background: transparent;
  font-size: 12px;
  color: #6d727a;
}

.filters button.active {
  border-color: #e5ebfc;
  color: #0c131f;
  background: #fff;
}

.filters span {
  color: #8d9198;
}

.small-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 5px 12px;
  background: #fff;
  border: 1px solid #dcdde1;
  border-radius: 3px;
  font-size: 12px;
}

.small-button svg {
  width: 14px;
  height: 14px;
}

.add-menu {
  position: relative;
  font-size: 12px;
  color: #396ffa;
}

.add-menu summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  cursor: pointer;
  border: 1px solid #396ffa;
  border-radius: 3px;
  padding: 5px 10px;
  list-style: none;
}

.add-menu summary::-webkit-details-marker {
  display: none;
}

.add-menu summary svg {
  width: 14px;
  height: 14px;
  flex: none;
}

.add-menu summary svg:last-child {
  width: 16px;
  height: 16px;
}

.add-menu>div {
  position: absolute;
  right: 0;
  top: 100%;
  min-width: 160px;
  z-index: 10;
  background: #fff;
  box-shadow: 0 4px 16px #0002;
}

.add-menu button {
  display: block;
  border: 0;
  background: #fff;
  padding: 10px;
  width: 100%;
  text-align: left;
}

.add-menu button:hover {
  background: #f5f7ff;
}

.table-scroll {
  overflow: auto;
  border: 1px solid #dcdde1;
  border-radius: 4px;
  max-height: 560px;
}

table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  min-width: 530px;
  font-size: 12px;
}

th {
  background: #f5f7ff;
  font-weight: 400;
  color: #9599a1;
  text-align: left;
  padding: 12px 8px;
}

td {
  height: 46px;
  border-top: 1px solid #e7e8e8;
  padding: 7px 8px;
  vertical-align: middle;
}

th:nth-child(2) {
  width: 40%;
}

th:nth-child(3) {
  width: 8%;
}

th:last-child {
  width: 75px;
}

.order-col {
  width: 24px;
  padding: 0;
}

.drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 28px;
  padding: 4px;
  border: 0;
  background: transparent;
  cursor: grab;
}

.drag-handle:active {
  cursor: grabbing;
}

.drag-handle svg {
  width: 16px;
  height: 16px;
}

.file-name {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: none;
  border: 0;
  padding: 0;
  color: inherit;
  max-width: 100%;
}

.file-name svg {
  flex: none;
  width: 16px;
  height: 16px;
}

.file-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name-cell small {
  display: block;
  overflow-wrap: anywhere;
  padding-top: 4px;
  line-height: 16px;
}

.size-cell {
  white-space: nowrap;
}

.password-field {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  border: 1px solid #dcdde1;
  border-radius: 3px;
  padding: 2px 8px;
  background: #fff;
}

.password-field>svg {
  width: 14px;
  height: 14px;
  flex: none;
}

.password-field input {
  width: 100%;
  min-width: 0;
  padding: 0;
  height: 20px;
  border: 0;
  background: transparent;
  font-size: 12px;
  outline: none;
}

.password-field:focus-within {
  border-color: #396ffa;
}

.password-field button {
  display: flex;
  padding: 0;
  border: 0;
  background: none;
}

.password-field button svg {
  width: 14px;
  height: 14px;
}

input::placeholder {
  color: #a1a5ad;
}

tr.failed {
  background: #fbeded;
}

.row-actions {
  display: flex;
  gap: 6px;
}

.row-actions button {
  background: none;
  border: 0;
  padding: 2px;
  color: #396ffa;
  font-size: 18px;
}

.row-actions svg {
  width: 16px;
  height: 16px;
}

.row-actions :deep(path) {
  fill: #396ffa;
}

.status-badge.success {
  color: #36aa7b;
}

.status-badge.failed {
  color: #d44040;
}

.list-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding-top: 12px;
}

.text-button {
  border: 0;
  background: none;
  color: #396ffa;
  font-size: 12px;
}

.progress-panel {
  position: relative;
  background: #f5f7ff;
  padding: 16px 24px 16px 56px;
  margin-bottom: 24px;
  border-radius: 4px;
  font-size: 12px;
}

.progress-panel>div {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
}

.progress-panel progress {
  height: 6px;
  flex: 1;
  border: 0;
  border-radius: 99px;
  overflow: hidden;
  accent-color: #396ffa;
}

.progress-panel progress::-webkit-progress-bar {
  background: #e7e8e8;
}

.progress-panel progress::-webkit-progress-value {
  background: #396ffa;
}

.processing-spinner {
  position: absolute;
  left: 24px;
  top: 20px;
  width: 20px;
  height: 20px;
  animation: batch-spin 1s linear infinite;
}

@keyframes batch-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .processing-spinner {
    animation: none;
  }
}

.progress-panel p {
  margin: 8px 0 0;
  overflow-wrap: anywhere;
}

.settings fieldset {
  padding: 0;
  border: 0;
  margin: 0;
  min-width: 0;
}

.settings h2 {
  margin-bottom: 20px;
}

.removal-note {
  line-height: 22px;
}

.settings :deep(.setting-row) {
  display: block;
  margin-bottom: 16px;
  min-height: 0;
}

.settings :deep(.setting-label) {
  flex-basis: auto;
  margin-bottom: 6px;
  font-size: 14px;
}

.settings :deep(.setting-row-switch) {
  column-gap: 12px;
  justify-content: space-between;
  min-height: 32px;
  margin-bottom: 16px;
}

.settings :deep(.setting-row-switch:last-child) {
  margin-bottom: 0;
}

.settings :deep(.ocr-section>.setting-row-switch) {
  margin-bottom: 8px;
}

.settings :deep(.ocr-options .setting-row) {
  margin-bottom: 0;
}

.settings :deep(.setting-row-switch .setting-label) {
  flex: 1;
  margin: 0;
}

.settings :deep(.setting-control) {
  width: 100%;
}

.settings :deep(.text-input),
.settings :deep(.num-input),
.settings :deep(.select-input) {
  width: 100%;
  height: 32px;
  border-radius: 3px;
  font-size: 14px;
  padding: 4px 8px;
}

.settings :deep(.setting-control .inline-group) {
  flex-wrap: wrap;
}

.settings :deep(.num-input) {
  min-width: 0;
}

.settings :deep(.radio-group) {
  flex-wrap: wrap;
  gap: 8px;
}

.settings :deep(.icc-profile-control) {
  width: 100%;
}

.settings :deep(.icc-dropzone) {
  width: 100%;
  height: 160px;
}

.main-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
}

.start-button {
  min-width: min(300px, 100%);
}

.error {
  color: #d44040;
  font-size: 12px;
  line-height: 20px;
}

.panel-error {
  text-align: center;
  overflow-wrap: anywhere;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

@media (max-width: 1050px) {
  .workspace-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .settings {
    width: 100%;
  }

  .empty-upload {
    min-height: 450px;
  }
}

@media (max-width: 575px) {
  .card {
    padding: 12px;
  }

  .empty-upload {
    min-height: 380px;
  }

  .upload-actions,
  .upload-actions button {
    width: 100%;
  }

  .primary,
  .outline {
    padding: 8px 16px;
  }

  .list-toolbar {
    gap: 8px;
  }

  .filters button {
    padding: 5px 8px;
  }

  .main-actions button {
    flex: 1;
  }

  .list-actions {
    flex-wrap: wrap;
  }

  .batch-panel {
    font-size: 13px;
  }
}
</style>
