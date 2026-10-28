<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Copy, Check, Eye, EyeOff } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import { dashboardApi, type ApiKeyInfo } from '@/api/dashboard';
import { copyText } from '@/lib/clipboard';

const { t } = useI18n();
const keys = ref<ApiKeyInfo[]>([]);
const loading = ref(true);
const copiedKeyId = ref<string | null>(null);
const copyFailed = ref(false);
const auditFailed = ref(false);
const visibleKeyIds = ref(new Set<string>());
let copyTimer: ReturnType<typeof setTimeout> | undefined;

onBeforeUnmount(() => clearTimeout(copyTimer));

onMounted(async () => {
  try {
    keys.value = await dashboardApi.apiKeys();
  } finally {
    loading.value = false;
  }
});

const rows = computed(() => keys.value.map((item) => ({
  ...item,
  name: t('apiKeys.defaultKey'),
  maskedKey: maskKey(item.key || item.keyId),
  expiry: t('apiKeys.never'),
})));

function maskKey(value: string) {
  if (value.length <= 11) return value;
  return `${value.slice(0, 7)}***${value.slice(-4)}`;
}

function toggleKeyVisibility(item: ApiKeyInfo) {
  if (!item.key) return;
  if (visibleKeyIds.value.has(item.keyId)) {
    visibleKeyIds.value.delete(item.keyId);
  } else {
    visibleKeyIds.value.add(item.keyId);
    void recordKeyAction(item, 'view');
  }
}

async function recordKeyAction(item: ApiKeyInfo, action: 'view' | 'copy') {
  try {
    await dashboardApi.recordApiKeyAction(item.keyId, action);
  } catch {
    auditFailed.value = true;
  }
}

async function copyKey(item: ApiKeyInfo) {
  if (!item.key) return;
  copyFailed.value = false;
  copiedKeyId.value = null;
  clearTimeout(copyTimer);
  try {
    await copyText(item.key);
    copiedKeyId.value = item.keyId;
    copyTimer = setTimeout(() => { if (copiedKeyId.value === item.keyId) copiedKeyId.value = null; }, 1800);
    void recordKeyAction(item, 'copy');
  } catch {
    copyFailed.value = true;
  }
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}
</script>

<template>
  <div class="mx-auto flex max-w-[1440px] flex-col gap-4 font-sans text-[#0c131f]">
    <h1 class="text-xl font-semibold leading-7">{{ t('apiKeys.title') }}</h1>
    <p v-if="copyFailed" role="alert" class="text-sm text-red-600">{{ t('apiKeys.copyFailed') }}</p>
    <p v-if="auditFailed" role="alert" class="text-sm text-red-600">{{ t('apiKeys.auditFailed') }}</p>
    <div class="overflow-x-auto rounded-md bg-white p-4 shadow-sm">
      <div v-if="loading" class="p-10 text-center text-sm text-slate-500">{{ t('common.loading') }}</div>
      <table v-else class="min-w-[960px] w-full table-fixed border-collapse text-sm">
        <colgroup>
          <col class="w-1/4">
          <col class="w-1/4">
          <col class="w-1/4">
          <col class="w-1/4">
        </colgroup>
        <thead>
          <tr class="h-[46px] bg-[#f5f7ff] text-left text-black/40">
            <th class="h-[46px] border-b border-[#e7e8e8] px-4 py-3 font-normal">{{ t('apiKeys.name') }}</th>
            <th class="h-[46px] w-[30%] border-b border-[#e7e8e8] px-4 py-3 font-normal">{{ t('apiKeys.key') }}</th>
            <th class="h-[46px] border-b border-[#e7e8e8] px-4 py-3 font-normal">{{ t('apiKeys.expiry') }}</th>
            <th class="h-[46px] border-b border-[#e7e8e8] px-4 py-3 font-normal">{{ t('apiKeys.lastUsed') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.keyId" class="h-[46px]">
            <td class="h-[46px] border-b border-[#e7e8e8] px-4 py-3">{{ row.name }}</td>
            <td class="h-[46px] border-b border-[#e7e8e8] px-4 py-[11px]">
              <div
                :class="['flex min-h-6 min-w-0 items-center gap-2 rounded-[3px] border px-4 py-0.5', row.key ? 'border-[#dcdde1] bg-white' : 'border-[#dcdde1] bg-[#eeeef0]']">
                <code
                  :class="['min-w-0 flex-1 text-xs leading-5', visibleKeyIds.has(row.keyId) ? 'whitespace-normal break-all' : 'truncate', row.key ? 'text-[#0c131f]' : 'text-black/25']">{{ visibleKeyIds.has(row.keyId) ? row.key : row.maskedKey }}</code>
                <button
                  type="button"
                  class="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-[#0C131F66] disabled:text-black/20"
                  :disabled="!row.key"
                  :aria-label="t(visibleKeyIds.has(row.keyId) ? 'apiKeys.hide' : 'apiKeys.show')"
                  :title="t(visibleKeyIds.has(row.keyId) ? 'apiKeys.hide' : 'apiKeys.show')"
                  :aria-pressed="visibleKeyIds.has(row.keyId)"
                  @click="toggleKeyVisibility(row)">
                  <EyeOff v-if="visibleKeyIds.has(row.keyId)" :size="14" />
                  <Eye v-else :size="14" />
                </button>
                <button
                  type="button"
                  class="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-[#396ffa] disabled:text-black/20"
                  :disabled="!row.key" :aria-label="t('apiKeys.copy')" @click="copyKey(row)">
                  <Check v-if="copiedKeyId === row.keyId" :size="14" />
                  <Copy v-else :size="14" class="text-[#0C131F66]" />
                </button></div>
            </td>
            <td class="h-[46px] border-b border-[#e7e8e8] px-4 py-3">{{ row.expiry }}</td>
            <td class="h-[46px] border-b border-[#e7e8e8] px-4 py-3" :class="row.lastUsedAt ? '' : 'text-black/40'">{{
              formatDate(row.lastUsedAt) }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="4" class="px-4 py-10 text-center text-sm text-black/40">{{ t('apiKeys.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
