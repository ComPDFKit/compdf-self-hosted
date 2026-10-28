<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, CheckCircle2, CircleStop, Download, Eye, LoaderCircle, Play, RefreshCw, RotateCcw, ShieldCheck, WifiOff } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  dashboardApi,
  type PreflightReport,
  type RuntimeModeStatus,
  type UpdateCheckResult,
  type UpdateJob,
  type UpdatePhase,
  type VersionInfo,
} from '@/api/dashboard';
import { toApiError } from '@/api/client';
import {
  UPDATE_OPERATION_TIMEOUT_MS,
  clearPendingUpdateOperation,
  createPendingUpdateOperation,
  loadPendingUpdateOperation,
  savePendingUpdateOperation,
  updateOperationOutcome,
  type PendingUpdateOperation,
  type UpdateOperationAction,
} from '@/config/update-recovery';

const { t, locale } = useI18n();
const version = ref<VersionInfo | null>(null);
const available = ref<UpdateCheckResult | null>(null);
const job = ref<UpdateJob | null>(null);
const history = ref<UpdateJob[]>([]);
const preflight = ref<PreflightReport | null>(null);
const runtime = ref<RuntimeModeStatus | null>(null);
const busy = ref<string | null>(null);
const cancelling = ref(false);
const pendingRequestId = ref('');
const error = ref<string | null>(null);
const confirmationOpen = ref(false);
const confirmationAction = ref<'install' | 'rollback' | null>(null);
const confirmationInput = ref('');
const selectedHistory = ref<UpdateJob | null>(null);
const pendingOperation = ref<PendingUpdateOperation | null>(loadPendingUpdateOperation());
const recoveryConnection = ref<'checking' | 'offline' | 'online' | 'timed-out'>('checking');
const recoveryTimedOut = ref(false);
const notice = ref<string | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let recoveryPollInFlight = false;
let operationRequestInFlight = false;
let lastDispatchAt = 0;

const terminal = computed(() => job.value?.phase === 'COMMITTED' || job.value?.phase === 'ROLLED_BACK');
const currentVersion = computed(() => terminal.value ? (version.value?.current ?? job.value?.targetVersion ?? '') : (job.value?.currentVersion ?? version.value?.current ?? ''));
const targetVersion = computed(() => terminal.value ? (available.value?.availableVersion ?? '') : (job.value?.targetVersion ?? available.value?.availableVersion ?? ''));
const requestId = computed(() => job.value?.requestId ?? '');
const latestConfirmed = computed(() => available.value
  ? !available.value.updateAvailable
  : !!version.value?.latest && !version.value.updateAvailable);
const pausedDownload = computed(() => job.value?.phase === 'PAUSED' && job.value.resumePhase === 'DOWNLOADING');
const operationPending = computed(() => !!pendingOperation.value);
const recoveryActive = computed(() => operationPending.value && !recoveryTimedOut.value);
const canDownload = computed(() => !!available.value?.updateAvailable && (!job.value || terminal.value || pausedDownload.value) && !busy.value && !operationPending.value);
const cancellableRequestId = computed(() => job.value?.phase === 'DOWNLOADING' ? job.value.requestId : pendingRequestId.value);
const canCancel = computed(() => !!cancellableRequestId.value && !cancelling.value && (busy.value === 'download' || job.value?.phase === 'DOWNLOADING'));
const canPreflight = computed(() => job.value?.phase === 'VERIFIED' && !busy.value && !operationPending.value);
const canPrepare = computed(() => ['PRECHECKED', 'BACKED_UP'].includes(job.value?.phase ?? '') && preflight.value?.overall !== 'block' && !busy.value && !operationPending.value);
const rollbackPhase = computed(() => job.value?.phase === 'COMMITTED' || job.value?.phase === 'ROLLBACK_REQUIRED');
const canRollback = computed(() => rollbackPhase.value && job.value?.recovery?.applicationRollbackAllowed === true && job.value.recovery.databaseRestoreRequired !== true && !busy.value && !operationPending.value);
const manualRecoveryRequired = computed(() => rollbackPhase.value && (!job.value?.recovery?.applicationRollbackAllowed || job.value.recovery.databaseRestoreRequired));
const active = computed(() => !!job.value && ['DOWNLOADING', 'BACKING_UP', 'DRAINING', 'MIGRATING', 'DEPLOYING', 'VERIFYING'].includes(job.value.phase));
const rollbackVersion = computed(() => job.value?.currentVersion ?? '');
const confirmationExpected = computed(() => confirmationAction.value === 'install' ? targetVersion.value : rollbackVersion.value);
const confirmationValid = computed(() => confirmationInput.value === confirmationExpected.value && !!confirmationExpected.value);

function phaseClass(phase: string) {
  if (phase === 'COMMITTED' || phase === 'VERIFIED' || phase === 'PRECHECKED') return 'bg-emerald-50 text-emerald-700';
  if (phase === 'FAILED' || phase === 'ROLLBACK_REQUIRED') return 'bg-rose-50 text-rose-700';
  if (phase === 'ROLLED_BACK' || phase === 'PAUSED') return 'bg-amber-50 text-amber-700';
  return 'bg-blue-50 text-brand-primary';
}

const phaseKeys: Record<UpdatePhase, string> = {
  AVAILABLE: 'updates.phase.AVAILABLE', DOWNLOADING: 'updates.phase.DOWNLOADING', VERIFIED: 'updates.phase.VERIFIED', PRECHECKED: 'updates.phase.PRECHECKED',
  BACKING_UP: 'updates.phase.BACKING_UP', BACKED_UP: 'updates.phase.BACKED_UP', DRAINING: 'updates.phase.DRAINING', MIGRATING: 'updates.phase.MIGRATING',
  DEPLOYING: 'updates.phase.DEPLOYING', VERIFYING: 'updates.phase.VERIFYING', COMMITTED: 'updates.phase.COMMITTED', FAILED: 'updates.phase.FAILED',
  PAUSED: 'updates.phase.PAUSED', ROLLBACK_REQUIRED: 'updates.phase.ROLLBACK_REQUIRED', ROLLED_BACK: 'updates.phase.ROLLED_BACK',
};

const eventKeys: Record<string, string> = {
  'update available': 'updates.event.available', 'release download started': 'updates.event.downloadStarted',
  'release download cancelled by administrator': 'updates.event.downloadCancelled', 'download retry requested': 'updates.event.downloadRetry',
  'release download resumed': 'updates.event.downloadResumed', 'upgrade backup started': 'updates.event.backupStarted',
  'backup retry requested': 'updates.event.backupRetry', 'upgrade backup resumed': 'updates.event.backupResumed',
  'maintenance and task drain confirmed by operator': 'updates.event.drained', 'database migration started': 'updates.event.migrationStarted',
  'application deployment started': 'updates.event.deploymentStarted', 'health and business verification started': 'updates.event.verificationStarted',
  'release committed after health and PDF smoke verification': 'updates.event.committed',
  'offline release and image digests imported and verified': 'updates.event.offlineImported',
  'approved application rollback started': 'updates.event.rollbackStarted', 'previous application release restored and verified': 'updates.event.rolledBack',
  'release artifacts downloaded and verified': 'updates.artifactsVerified', 'environment preflight passed': 'updates.preflightPassed',
  'complete backup created and verified': 'updates.backupCompleted',
};

function phaseLabel(phase: string) {
  const key = Object.hasOwn(phaseKeys, phase) ? phaseKeys[phase as UpdatePhase] : undefined;
  return key ? t(key) : phase;
}

function eventMessage(message: string) {
  const key = Object.hasOwn(eventKeys, message) ? eventKeys[message] : undefined;
  return key ? t(key) : message;
}

function levelLabel(level: string) {
  return ['pass', 'warn', 'block'].includes(level) ? t(`updates.level.${level}`) : level;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString(locale.value);
}

onMounted(async () => {
  if (pendingOperation.value) busy.value = pendingOperation.value.action;
  await refreshAll();
  if (pendingOperation.value) void recoverPendingOperation();
  pollTimer = setInterval(() => {
    if (pendingOperation.value && !recoveryTimedOut.value) void recoverPendingOperation();
    else if (active.value || busy.value === 'download') void refreshStatus();
  }, 2500);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

async function refreshAll() {
  error.value = null;
  const results = await Promise.allSettled([dashboardApi.version(), dashboardApi.updateStatus(), dashboardApi.runtimeMode(), dashboardApi.updateHistory()]);
  if (results[0].status === 'fulfilled') version.value = results[0].value;
  if (results[1].status === 'fulfilled') job.value = results[1].value;
  if (results[2].status === 'fulfilled') runtime.value = results[2].value;
  if (results[3].status === 'fulfilled') history.value = results[3].value;
}

async function refreshStatus() {
  try {
    job.value = await dashboardApi.updateStatus();
    runtime.value = await dashboardApi.runtimeMode();
  } catch {
    // Keep the last durable state visible while the server or updater restarts.
  }
}

async function runAction(name: string, action: () => Promise<void>) {
  busy.value = name;
  error.value = null;
  try {
    await action();
  } catch (cause) {
    error.value = (await toApiError(cause)).message;
    await refreshStatus();
  } finally {
    busy.value = null;
  }
}

function newRequestId() {
  return `dashboard-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;
}

function progressLabel(update: UpdateJob) {
  switch (update.phase) {
    case 'VERIFIED': return t('updates.artifactsVerified');
    case 'PRECHECKED': return t('updates.preflightPassed');
    case 'BACKING_UP': return t('updates.backingUp');
    case 'BACKED_UP': return t('updates.backupCompleted');
    case 'DRAINING': return t('updates.drainingTasks');
    case 'MIGRATING': return t('updates.migratingDatabase');
    case 'DEPLOYING': return t('updates.deployingApplication');
    case 'VERIFYING': return t('updates.verifyingApplication');
    case 'COMMITTED': return t('updates.installCompleted');
    case 'ROLLED_BACK': return t('updates.rollbackCompleted');
    case 'FAILED': return t('updates.operationFailed');
    default: return update.progress?.stage === 'images' ? t('updates.pullingImages') : (update.progress?.item || t('updates.downloadingArtifacts'));
  }
}

async function check() {
  // Do not keep a previous success banner when a fresh signed check fails.
  available.value = null;
  if (version.value) version.value = { ...version.value, latest: null };
  await runAction('check', async () => {
    const current = await dashboardApi.version();
    version.value = current;
    try {
      available.value = await dashboardApi.checkUpdate(current.current);
    } catch (cause) {
      version.value = { ...current, latest: null };
      throw cause;
    }
  });
}

async function download() {
  const id = pausedDownload.value ? requestId.value : newRequestId();
  pendingRequestId.value = id;
  try {
    await runAction('download', async () => {
      const result = await dashboardApi.downloadUpdate({
        currentVersion: currentVersion.value,
        targetVersion: targetVersion.value,
        requestId: id,
      });
      job.value = result.job;
    });
  } finally {
    pendingRequestId.value = '';
  }
}

async function cancelDownload() {
  const id = cancellableRequestId.value;
  if (!id) return;
  cancelling.value = true;
  error.value = null;
  try {
    const result = await dashboardApi.cancelUpdate({ requestId: id });
    job.value = result.job;
    await refreshStatus();
  } catch (cause) {
    error.value = (await toApiError(cause)).message;
  } finally {
    cancelling.value = false;
  }
}

async function runPreflight() {
  await runAction('preflight', async () => {
    preflight.value = await dashboardApi.preflightUpdate({
      currentVersion: currentVersion.value,
      targetVersion: targetVersion.value,
      requestId: requestId.value,
    });
    await refreshStatus();
  });
}

function openConfirmation(action: 'install' | 'rollback') {
  confirmationAction.value = action;
  confirmationInput.value = '';
  confirmationOpen.value = true;
}

function updateConfirmationOpen(open: boolean) {
  confirmationOpen.value = open;
  if (!open) confirmationInput.value = '';
}

async function confirmHighRiskAction() {
  if (!confirmationValid.value || !confirmationAction.value) return;
  const action = confirmationAction.value;
  confirmationOpen.value = false;
  confirmationInput.value = '';
  if (action === 'install') await prepareAndApply();
  else await rollback();
}

async function prepareAndApply() {
  busy.value = 'apply';
  error.value = null;
  notice.value = null;
  try {
    runtime.value = await dashboardApi.setRuntimeMode({ mode: 'draining', requestId: requestId.value, reason: 'Preparing approved product update' });
    if (!runtime.value.tasks.drained) {
      error.value = t('updates.tasksActive', { count: runtime.value.tasks.active });
      busy.value = null;
      return;
    }
    runtime.value = await dashboardApi.setRuntimeMode({ mode: 'maintenance', requestId: requestId.value, reason: 'Approved update installation' });
    if (job.value?.phase !== 'BACKED_UP') {
      await dashboardApi.backupUpdate({ currentVersion: currentVersion.value, requestId: requestId.value, approve: true, maintenanceConfirmed: true });
    }
    const operation = beginOperation('install');
    await dispatchPendingOperation(operation);
    void recoverPendingOperation();
  } catch (cause) {
    if (!pendingOperation.value) {
      error.value = (await toApiError(cause)).message;
      busy.value = null;
    } else {
      recoveryConnection.value = 'offline';
    }
  }
}

async function rollback() {
  error.value = null;
  notice.value = null;
  const operation = beginOperation('rollback');
  await dispatchPendingOperation(operation);
  void recoverPendingOperation();
}

function beginOperation(action: UpdateOperationAction): PendingUpdateOperation {
  const operation = createPendingUpdateOperation(
    action,
    requestId.value,
    job.value?.currentVersion || currentVersion.value,
    job.value?.targetVersion || targetVersion.value,
  );
  savePendingUpdateOperation(operation);
  pendingOperation.value = operation;
  recoveryTimedOut.value = false;
  recoveryConnection.value = 'checking';
  busy.value = action;
  return operation;
}

async function dispatchPendingOperation(operation: PendingUpdateOperation) {
  if (operationRequestInFlight) return;
  operationRequestInFlight = true;
  lastDispatchAt = Date.now();
  try {
    const result = operation.action === 'install'
      ? await dashboardApi.applyUpdate({
        currentVersion: operation.currentVersion,
        targetVersion: operation.targetVersion,
        requestId: operation.requestId,
        approve: true,
        maintenanceConfirmed: true,
        offlineRiskConfirmed: job.value?.delivery === 'offline',
      })
      : await dashboardApi.rollbackUpdate({ requestId: operation.requestId, approve: true });
    job.value = result.job;
    recoveryConnection.value = 'online';
  } catch {
    // The server container is expected to disappear while replacing itself.
    recoveryConnection.value = 'offline';
  } finally {
    operationRequestInFlight = false;
  }
}

async function recoverPendingOperation() {
  const operation = pendingOperation.value;
  if (!operation || recoveryPollInFlight) return;
  if (Date.now() >= operation.deadlineAt) {
    recoveryTimedOut.value = true;
    recoveryConnection.value = 'timed-out';
    busy.value = null;
    return;
  }

  recoveryPollInFlight = true;
  try {
    const current = await dashboardApi.updateStatus();
    recoveryConnection.value = 'online';
    if (current?.requestId === operation.requestId) job.value = current;

    const outcome = updateOperationOutcome(operation, current);
    if (outcome === 'succeeded') {
      const reason = operation.action === 'install' ? 'Update completed and verified' : 'Application rollback completed and verified';
      runtime.value = await dashboardApi.setRuntimeMode({ mode: 'normal', requestId: operation.requestId, reason });
      clearPendingUpdateOperation();
      pendingOperation.value = null;
      busy.value = null;
      recoveryTimedOut.value = false;
      notice.value = t(operation.action === 'install' ? 'updates.installSucceeded' : 'updates.rollbackSucceeded');
      await refreshAll();
      return;
    }
    if (outcome === 'failed') {
      clearPendingUpdateOperation();
      pendingOperation.value = null;
      busy.value = null;
      recoveryTimedOut.value = false;
      error.value = current?.failure || t('updates.operationFailed');
      await refreshAll();
      return;
    }

    const retryable = operation.action === 'install' ? current?.phase === 'BACKED_UP' : current?.phase === 'COMMITTED';
    if (retryable && !operationRequestInFlight && Date.now() - lastDispatchAt >= 15_000) {
      void dispatchPendingOperation(operation);
    }
  } catch {
    recoveryConnection.value = 'offline';
  } finally {
    recoveryPollInFlight = false;
  }
}

function retryRecovery() {
  if (!pendingOperation.value) return;
  const operation = { ...pendingOperation.value, deadlineAt: Date.now() + UPDATE_OPERATION_TIMEOUT_MS };
  savePendingUpdateOperation(operation);
  pendingOperation.value = operation;
  recoveryTimedOut.value = false;
  recoveryConnection.value = 'checking';
  busy.value = operation.action;
  void recoverPendingOperation();
}

async function resumeNormal() {
  if (!runtime.value || !requestId.value) return;
  await runAction('resume', async () => {
    runtime.value = await dashboardApi.setRuntimeMode({ mode: 'normal', requestId: requestId.value, reason: 'Administrator resumed normal service' });
  });
}
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-6 pb-12 font-sans">
    <div v-if="recoveryActive" class="fixed inset-0 z-50 flex min-h-screen items-center justify-center bg-white/95 px-6" role="status" aria-live="polite">
      <div class="w-full max-w-xl text-center">
        <LoaderCircle :size="42" class="mx-auto animate-spin text-brand-primary" aria-hidden="true" />
        <h2 class="mt-6 text-2xl font-bold text-brand-on-surface">{{ pendingOperation?.action === 'install' ? t('updates.installingTitle') : t('updates.rollingBackTitle') }}</h2>
        <p class="mx-auto mt-3 max-w-lg text-sm leading-6 text-brand-secondary">
          {{ recoveryConnection === 'offline' ? t('updates.recoveryOffline') : t('updates.recoveryChecking') }}
        </p>
        <div class="mx-auto mt-7 grid max-w-md gap-3 text-left sm:grid-cols-2">
          <div class="min-w-0 rounded-lg border border-brand-outline-variant/50 bg-white p-4"><p class="text-xs font-semibold text-brand-secondary">{{ t('updates.status') }}</p><p class="mt-1 truncate font-mono text-sm font-bold text-brand-primary">{{ job?.requestId === pendingOperation?.requestId ? (job?.phase ? phaseLabel(job.phase) : t('updates.reconnecting')) : t('updates.reconnecting') }}</p></div>
          <div class="min-w-0 rounded-lg border border-brand-outline-variant/50 bg-white p-4"><p class="text-xs font-semibold text-brand-secondary">{{ t('updates.requestId') }}</p><p class="mt-1 truncate font-mono text-xs text-brand-on-surface" :title="pendingOperation?.requestId">{{ pendingOperation?.requestId }}</p></div>
        </div>
      </div>
    </div>

    <header>
      <div>
        <h1 class="text-2xl font-bold text-brand-on-surface">{{ t('updates.title') }}</h1>
        <p class="mt-1 text-sm text-brand-secondary">{{ t('updates.subtitle') }}</p>
      </div>
    </header>

    <div v-if="error" class="flex items-start gap-3 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-800">
      <AlertTriangle :size="18" class="mt-0.5 shrink-0" /><span class="min-w-0 break-words">{{ error }}</span>
    </div>

    <div v-if="notice" class="flex items-start gap-3 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      <CheckCircle2 :size="18" class="mt-0.5 shrink-0" /><span class="min-w-0 break-words">{{ notice }}</span>
    </div>

    <div v-if="pendingOperation && recoveryTimedOut" class="flex flex-col gap-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-start gap-3"><WifiOff :size="18" class="mt-0.5 shrink-0" /><div><p class="font-bold">{{ t('updates.recoveryTimedOutTitle') }}</p><p class="mt-1 leading-6">{{ t('updates.recoveryTimedOutDescription') }}</p></div></div>
      <button type="button" class="h-10 shrink-0 rounded-lg border border-amber-300 bg-white px-4 font-semibold transition hover:bg-amber-100" @click="retryRecovery"><RefreshCw :size="16" class="mr-2 inline" />{{ t('updates.checkAgain') }}</button>
    </div>

    <section class="overflow-hidden rounded-2xl border border-brand-outline-variant/50 bg-white shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-brand-outline-variant/30 px-5 py-4 sm:px-6">
        <h2 class="text-base font-bold text-brand-on-surface">{{ t('updates.releaseTitle', { version: currentVersion || '—' }) }}</h2>
        <button type="button" class="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-semibold text-white shadow-xs transition hover:opacity-90 disabled:opacity-50" :disabled="!!busy || !currentVersion" @click="check"><RefreshCw :size="17" />{{ t('updates.check') }}</button>
      </div>
      <div class="p-5 sm:p-6">
        <p v-if="currentVersion" class="font-semibold text-brand-on-surface">{{ t('updates.releaseNotesTitle', { version: currentVersion }) }}</p>
        <p v-if="version?.releaseNotes" class="mt-3 whitespace-pre-wrap text-sm leading-6 text-brand-on-surface">{{ version.releaseNotes }}</p>
        <div v-if="latestConfirmed" class="mt-4 inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
          <CheckCircle2 :size="17" />{{ t('updates.latest') }}
        </div>
        <template v-else-if="available?.updateAvailable">
          <div class="mt-5 border-t border-brand-outline-variant/30 pt-5">
            <p class="text-sm font-semibold text-brand-on-surface">{{ t('updates.latestVersion', { version: available.availableVersion }) }}</p>
            <p v-if="available.releaseNotes" class="mt-3 whitespace-pre-wrap text-sm leading-6 text-brand-on-surface">{{ available.releaseNotes }}</p>
            <ul v-if="available.knownIssues?.length" class="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-800"><li v-for="issue in available.knownIssues" :key="issue">{{ issue }}</li></ul>
          </div>
        </template>
        <div class="mt-5 flex flex-wrap gap-2.5">
          <button type="button" class="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-brand-outline-variant/70 bg-white px-4 text-sm font-semibold text-brand-primary transition hover:bg-brand-surface-container-low disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" :disabled="!canDownload" @click="download"><Download :size="17" />{{ pausedDownload ? t('updates.resumeDownload') : t('updates.download') }}</button>
          <button v-if="cancellableRequestId" type="button" class="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" :disabled="!canCancel" @click="cancelDownload"><CircleStop :size="17" />{{ cancelling ? t('updates.cancelling') : t('updates.cancelDownload') }}</button>
          <button type="button" class="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-brand-outline-variant/70 bg-white px-4 text-sm font-semibold text-brand-primary transition hover:bg-brand-surface-container-low disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" :disabled="!canPreflight" @click="runPreflight"><ShieldCheck :size="17" />{{ t('updates.preflight') }}</button>
          <button type="button" class="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-semibold text-white shadow-xs transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" :disabled="!canPrepare" @click="openConfirmation('install')"><Play :size="17" />{{ t('updates.install') }}</button>
          <button type="button" class="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" :disabled="!canRollback" @click="openConfirmation('rollback')"><RotateCcw :size="17" />{{ t('updates.rollback') }}</button>
          <button v-if="runtime?.state.mode !== 'normal'" type="button" class="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-brand-outline-variant/70 px-4 text-sm font-semibold text-brand-on-surface transition hover:bg-brand-surface-container-low disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" :disabled="!!busy || active" @click="resumeNormal"><RefreshCw :size="17" />{{ t('updates.resume') }}</button>
        </div>
      </div>
    </section>

    <section v-if="preflight" class="overflow-hidden rounded-2xl border border-brand-outline-variant/50 bg-white shadow-sm">
      <div class="flex items-center gap-2 border-b border-brand-outline-variant/30 px-5 py-4 sm:px-6"><CheckCircle2 :size="18" :class="preflight.overall === 'block' ? 'text-red-600' : 'text-emerald-600'" /><h2 class="text-sm font-bold text-brand-on-surface">{{ t('updates.preflightResults') }}</h2></div>
      <div class="divide-y divide-brand-outline-variant/30">
        <div v-for="checkItem in preflight.checks" :key="checkItem.id" class="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[10rem_5rem_1fr] sm:px-6">
          <span class="font-mono text-xs text-brand-secondary">{{ checkItem.id }}</span><span class="font-semibold" :class="checkItem.level === 'block' ? 'text-red-600' : checkItem.level === 'warn' ? 'text-amber-600' : 'text-emerald-600'">{{ levelLabel(checkItem.level) }}</span><span class="text-brand-on-surface">{{ checkItem.message }}</span>
        </div>
      </div>
    </section>

    <section v-if="job" class="overflow-hidden rounded-2xl border border-brand-outline-variant/50 bg-white shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-brand-outline-variant/30 px-5 py-4 sm:px-6"><h2 class="text-sm font-bold text-brand-on-surface">{{ t('updates.progress') }}</h2><span class="rounded-md px-2.5 py-1 text-xs font-bold" :class="phaseClass(job.phase)">{{ phaseLabel(job.phase) }}</span></div>
      <div v-if="manualRecoveryRequired" class="border-b border-red-200 bg-red-50 px-5 py-4 text-sm text-red-900">
        <div class="flex items-start gap-3"><AlertTriangle :size="18" class="mt-0.5 shrink-0" /><div class="min-w-0"><p class="font-bold">{{ t('updates.manualRecoveryTitle') }}</p><p class="mt-1 leading-6">{{ t('updates.manualRecoveryDescription') }}</p><p v-if="job.backupId" class="mt-2 break-all font-mono text-xs">{{ t('updates.backupId') }}: {{ job.backupId }}</p></div></div>
      </div>
      <div v-if="job.phase === 'DOWNLOADING' && job.progress" class="border-b border-brand-outline-variant/30 px-5 py-4 sm:px-6">
        <div class="mb-2 flex min-w-0 items-center justify-between gap-4 text-xs text-brand-secondary">
          <span class="min-w-0 truncate">{{ progressLabel(job) }}</span>
          <span class="shrink-0 font-mono">{{ job.progress.indeterminate ? t('updates.inProgress') : `${job.progress.percent}%` }}</span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-brand-surface-container" role="progressbar" :aria-valuenow="job.progress.indeterminate ? undefined : job.progress.percent" aria-valuemin="0" aria-valuemax="100">
          <div class="h-full rounded-full bg-brand-primary transition-[width] duration-300" :class="job.progress.indeterminate ? 'animate-pulse' : ''" :style="{ width: job.progress.indeterminate ? '100%' : `${job.progress.percent}%` }"></div>
        </div>
      </div>
      <ol class="divide-y divide-brand-outline-variant/30">
        <li v-for="event in [...job.events].reverse()" :key="event.revision" class="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[11rem_9rem_1fr] sm:px-6"><time class="text-xs text-brand-secondary">{{ formatDate(event.at) }}</time><span class="text-xs font-semibold text-brand-on-surface">{{ phaseLabel(event.phase) }}</span><span class="min-w-0 break-words text-brand-secondary">{{ eventMessage(event.message) }}</span></li>
      </ol>
    </section>

    <section class="overflow-hidden rounded-2xl border border-brand-outline-variant/50 bg-white shadow-sm">
      <div class="border-b border-brand-outline-variant/30 px-5 py-4 sm:px-6"><h2 class="text-sm font-bold text-brand-on-surface">{{ t('updates.history') }}</h2></div>
      <div v-if="history.length" class="divide-y divide-brand-outline-variant/30">
        <button v-for="item in history.slice(0, 10)" :key="item.requestId" type="button" class="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-1 px-5 py-3 text-left text-sm transition hover:bg-brand-surface-container-low sm:grid-cols-[1fr_9rem_11rem_2.5rem] sm:items-center sm:px-6" :title="t('updates.viewDetails')" @click="selectedHistory = item">
          <div class="min-w-0"><p class="font-semibold text-brand-on-surface">v{{ item.currentVersion }} → v{{ item.targetVersion }}</p><p class="truncate font-mono text-xs text-brand-secondary">{{ item.requestId }}</p></div>
          <span class="w-fit rounded-md px-2.5 py-1 text-xs font-bold" :class="phaseClass(item.phase)">{{ phaseLabel(item.phase) }}</span>
          <time class="text-xs text-brand-secondary sm:text-right">{{ formatDate(item.updatedAt) }}</time>
          <Eye :size="17" class="justify-self-end text-brand-secondary" aria-hidden="true" />
        </button>
      </div>
      <p v-else class="px-5 py-6 text-sm text-brand-secondary sm:px-6">{{ t('updates.noHistory') }}</p>
    </section>

    <Dialog :open="confirmationOpen" @update:open="updateConfirmationOpen">
      <DialogContent class="max-w-md">
        <form @submit.prevent="confirmHighRiskAction">
          <DialogHeader>
            <DialogTitle class="text-base font-bold text-brand-on-surface">{{ confirmationAction === 'install' ? t('updates.confirmInstallTitle') : t('updates.confirmRollbackTitle') }}</DialogTitle>
            <DialogDescription class="text-sm leading-6 text-brand-secondary">{{ confirmationAction === 'install' ? t('updates.confirmInstallDescription', { version: targetVersion }) : t('updates.confirmRollbackDescription') }}</DialogDescription>
          </DialogHeader>
          <p v-if="confirmationAction === 'install' && job?.delivery === 'offline'" class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{{ t('updates.offlineRiskConfirm') }}</p>
          <label class="mt-5 block text-xs font-semibold text-brand-on-surface" for="update-confirmation">{{ t('updates.confirmPrompt', { value: confirmationExpected }) }}</label>
          <input id="update-confirmation" v-model="confirmationInput" type="text" autocomplete="off" spellcheck="false" class="mt-2 h-11 w-full rounded-lg border border-brand-outline-variant bg-white px-3 font-mono text-sm text-brand-on-surface outline-none focus:border-brand-primary" :placeholder="confirmationExpected" />
          <DialogFooter class="mt-6 flex gap-2 sm:justify-end">
            <button type="button" class="h-10 rounded-lg border border-brand-outline-variant px-4 text-sm font-semibold text-brand-on-surface transition hover:bg-brand-surface-container-low" @click="updateConfirmationOpen(false)">{{ t('common.cancel') }}</button>
            <button type="submit" class="h-10 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40" :disabled="!confirmationValid">{{ confirmationAction === 'install' ? t('updates.install') : t('updates.rollback') }}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!selectedHistory" @update:open="(open) => { if (!open) selectedHistory = null; }">
      <DialogContent class="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle class="text-base font-bold text-brand-on-surface">{{ t('updates.historyDetails') }}</DialogTitle>
          <DialogDescription v-if="selectedHistory" class="break-all font-mono text-xs text-brand-secondary">{{ selectedHistory.requestId }}</DialogDescription>
        </DialogHeader>
        <div v-if="selectedHistory" class="mt-4 space-y-4">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-lg bg-brand-surface-container-low p-3"><p class="text-xs text-brand-secondary">{{ t('updates.current') }}</p><p class="mt-1 font-bold">v{{ selectedHistory.currentVersion }}</p></div>
            <div class="rounded-lg bg-brand-surface-container-low p-3"><p class="text-xs text-brand-secondary">{{ t('updates.available') }}</p><p class="mt-1 font-bold">v{{ selectedHistory.targetVersion }}</p></div>
            <div class="rounded-lg bg-brand-surface-container-low p-3"><p class="text-xs text-brand-secondary">{{ t('updates.status') }}</p><p class="mt-1 font-mono text-sm font-bold text-brand-primary">{{ phaseLabel(selectedHistory.phase) }}</p></div>
          </div>
          <p v-if="selectedHistory.failure" class="border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-900">{{ selectedHistory.failure }}</p>
          <ol class="divide-y divide-brand-outline-variant/40 border border-brand-outline-variant/60">
            <li v-for="event in [...selectedHistory.events].reverse()" :key="event.revision" class="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[10rem_8rem_1fr]"><time class="text-xs text-brand-secondary">{{ formatDate(event.at) }}</time><span class="text-xs font-semibold">{{ phaseLabel(event.phase) }}</span><span class="break-words text-brand-secondary">{{ eventMessage(event.message) }}</span></li>
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
