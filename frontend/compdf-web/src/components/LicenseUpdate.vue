<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { LoaderCircle, Upload } from 'lucide-vue-next';
import { dashboardApi, type LicenseUpdateStatus } from '@/api/dashboard';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const { t } = useI18n();
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
const job = ref<LicenseUpdateStatus | null>(null);
const file = ref<File | null>(null);
const input = ref<HTMLInputElement>();
const dialog = ref(false);
const submitting = ref(false);
const error = ref('');
const pollError = ref('');
const loading = ref(true);
const busy = computed(() => submitting.value || (!!job.value && !['SUCCEEDED', 'FAILED', 'ROLLED_BACK', 'RECOVERY_REQUIRED'].includes(job.value.phase)));
const needsRecovery = computed(() => job.value?.phase === 'RECOVERY_REQUIRED');
const phases = computed<Record<string, string>>(() => ({
  DRAINING: t('license.update.phase.draining'),
  DISPATCHING: t('license.update.phase.dispatching'),
  VALIDATING: t('license.update.phase.validating'),
  REPLACING: t('license.update.phase.replacing'),
  RESTARTING: t('license.update.phase.restarting'),
  RESTORING: t('license.update.phase.restoring'),
  SUCCEEDED: t('license.update.phase.succeeded'),
  FAILED: t('license.update.phase.failed'),
  ROLLED_BACK: t('license.update.phase.rolledBack'),
  RECOVERY_REQUIRED: t('license.update.phase.recoveryRequired'),
}));
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
function message(e: unknown) { return (e as { message?: string })?.message || t('license.update.requestFailed'); }
async function poll() {
  try { job.value = await dashboardApi.licenseUpdateStatus(); pollError.value = ''; }
  catch (e) { pollError.value = message(e); }
  finally { loading.value = false; if (!stopped) timer = setTimeout(poll, 2500); }
}
function select(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  if (!selected) return;
  if (!/^license[^/\\]*\.xml$/i.test(selected.name) || selected.size === 0 || selected.size > 65536) {
    error.value = t('license.update.invalidFile');
    (event.target as HTMLInputElement).value = ''; return;
  }
  file.value = selected; error.value = ''; dialog.value = true;
}
async function install() {
  if (!file.value) return;
  submitting.value = true; error.value = '';
  try { job.value = await dashboardApi.updateLicense(file.value); dialog.value = false; }
  catch (e) { error.value = message(e); }
  finally { submitting.value = false; if (input.value) input.value.value = ''; }
}
async function recover() {
  submitting.value = true;
  try { job.value = await dashboardApi.recoverLicense(); error.value = ''; }
  catch (e) { error.value = message(e); }
  finally { submitting.value = false; }
}
onMounted(poll);
onUnmounted(() => { stopped = true; clearTimeout(timer); });
</script>

<template>
  <div :class="props.compact ? 'flex min-w-0 flex-col items-start gap-2' : 'mt-6 space-y-3 border-t border-slate-100 pt-4'" data-test="license-update">
    <input ref="input" type="file" accept=".xml,application/xml,text/xml" class="hidden" :disabled="busy || needsRecovery" @change="select">
    <div class="flex max-w-full flex-wrap items-center gap-2">
      <slot name="actions" />
      <button
        :class="props.compact
          ? 'inline-flex h-8 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded border border-[#396ffa] bg-white px-4 text-sm text-[#396ffa] disabled:opacity-50'
          : 'inline-flex items-center gap-2 rounded-xl bg-[#2563eb] px-4 py-2 text-xs font-bold text-white disabled:opacity-50'"
        :disabled="loading || busy || needsRecovery"
        @click="input?.click()"
      >
        <LoaderCircle v-if="busy" :size="15" class="shrink-0 animate-spin" /><Upload v-else :size="15" class="shrink-0" />
        {{ t('license.update.online') }}
      </button>
    </div>
    <p v-if="!props.compact" class="text-xs text-stone-500">{{ t('license.update.description') }}</p>
    <div v-if="job" role="status" aria-live="polite" class="w-full min-w-0 space-y-1 break-words text-xs" :class="['FAILED','ROLLED_BACK','RECOVERY_REQUIRED'].includes(job.phase) ? 'text-amber-700' : 'text-blue-700'">
      <p>{{ phases[job.phase] || job.phase }}</p>
      <p v-if="job.error" class="break-words">{{ job.error }}</p>
      <p class="text-stone-400">{{ new Date(job.updatedAt).toLocaleString() }}</p>
    </div>
    <button v-if="needsRecovery" class="text-xs font-bold text-amber-700 underline" :disabled="submitting" @click="recover">{{ t('license.update.restore') }}</button>
    <p v-if="error || pollError" role="alert" class="w-full min-w-0 break-words text-xs text-red-600">{{ error || pollError }}</p>
    <Dialog v-model:open="dialog">
      <DialogContent class="sm:max-w-lg rounded-2xl">
        <DialogHeader>
          <DialogTitle>{{ t('license.update.confirmTitle') }}</DialogTitle>
          <DialogDescription>{{ t('license.update.confirmDescription') }}</DialogDescription>
        </DialogHeader>
        <p class="text-sm break-all">{{ file?.name }}</p>
        <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
        <DialogFooter>
          <button class="rounded-xl border px-4 py-2 text-sm" :disabled="submitting" @click="dialog = false">{{ t('license.update.cancel') }}</button>
          <button class="rounded-xl bg-[#2563eb] px-4 py-2 text-sm text-white disabled:opacity-50" :disabled="submitting" @click="install">{{ t('license.update.confirmAction') }}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
