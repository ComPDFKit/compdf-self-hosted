<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Search, Download, FileText, AlertCircle, Info, Eye, X } from 'lucide-vue-next';
import { dashboardApi, type LogEntry, type LogsQuery, type LogType, type LogLevel, type LogTimeRange } from '@/api/dashboard';
import { formatDateTime } from '@/lib/format';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const { t } = useI18n();

const logs = ref<LogEntry[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);

const searchTerm = ref('');
const typeFilter = ref<'ALL' | LogType>('ALL');
const levelFilter = ref<'ALL' | LogLevel>('ALL');
const timeRange = ref<LogTimeRange>('1h');
const selectedLog = ref<LogEntry | null>(null);
const exporting = ref(false);
const exportConfirmOpen = ref(false);

const query = computed<LogsQuery>(() => ({
  keyword: searchTerm.value || undefined,
  logType: typeFilter.value === 'ALL' ? undefined : typeFilter.value,
  level: levelFilter.value === 'ALL' ? undefined : levelFilter.value,
  timeRange: timeRange.value,
  page: page.value,
  pageSize,
}));

async function fetchLogs() {
  loading.value = true;
  try {
    const res = await dashboardApi.logs(query.value);
    logs.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}
onMounted(fetchLogs);

function applySearch() {
  page.value = 1;
  fetchLogs();
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

async function exportCsv() {
  exporting.value = true;
  try {
    const blob = await dashboardApi.exportLogs(query.value);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `operation_logs_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  } finally {
    exporting.value = false;
    exportConfirmOpen.value = false;
  }
}

const typeLabel = computed<Record<string, string>>(() => ({
  api_call: t('logs.type.api_call'),
  user_action: t('logs.type.user_action'),
  error: t('logs.type.error'),
  system: t('logs.type.system'),
}));
const levelLabel = computed<Record<string, string>>(() => ({
  INFO: t('logs.level.INFO'),
  WARN: t('logs.level.WARN'),
  ERROR: t('logs.level.ERROR'),
  FATAL: t('logs.level.FATAL'),
}));
const typeFilters = computed(() => [
  { v: 'ALL', l: t('logs.typeAll') },
  { v: 'api_call', l: t('logs.type.api_call') },
  { v: 'user_action', l: t('logs.type.user_action') },
  { v: 'error', l: t('logs.type.error') },
  { v: 'system', l: t('logs.type.system') },
]);

/** PRD §5: 操作人 — api_call→空, system→系统, 其余→username */
function operatorOf(log: LogEntry): string {
  if (log.logType === 'api_call') return '';
  if (log.logType === 'system') return t('common.system');
  return log.operator ?? '—';
}

function typeBadgeClass(t: string) {
  return t === 'api_call' ? 'bg-blue-100/75 text-blue-700'
    : t === 'user_action' ? 'bg-purple-100/75 text-purple-700'
    : t === 'error' ? 'bg-rose-100/75 text-rose-700'
    : 'bg-slate-100/75 text-slate-700';
}
function levelBadgeClass(l: string) {
  return l === 'ERROR' || l === 'FATAL' ? 'bg-rose-500/10 text-rose-600 border-rose-500/25'
    : l === 'WARN' ? 'bg-amber-100 text-amber-700 border-amber-500/25'
    : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/25';
}
function resultBadgeClass(r: string | null) {
  return r === 'success' ? 'bg-emerald-50 text-emerald-600'
    : r === 'fail' ? 'bg-rose-500/10 text-brand-error'
    : 'bg-slate-100 text-slate-600';
}
function resultLabel(r: string | null) {
  return r === 'success' ? t('overview.success') : r === 'fail' ? t('overview.fail') : t('logs.neutral');
}
function categoryLabel(c: string | null): string {
  switch (c) {
    case 'success': return t('overview.success');
    case 'invalid': return t('overview.invalid');
    case 'fail': return t('overview.fail');
    case 'exception': return t('overview.exception');
    default: return c ?? '—';
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Filter bar -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 border border-brand-outline-variant/50 rounded-2xl">
      <div class="flex flex-wrap items-center gap-3 flex-1">
        <div class="relative w-full md:w-60">
          <input
            v-model="searchTerm"
            type="text"
            :placeholder="t('logs.searchPlaceholder')"
            class="w-full text-xs bg-brand-surface-container-low border border-brand-outline-variant/30 rounded-xl py-2 pl-9 pr-4 text-brand-on-surface focus:outline-none focus:border-brand-primary placeholder:text-brand-secondary/60"
            @keyup.enter="applySearch"
          />
          <Search :size="14" class="absolute left-3 top-2.5 text-brand-secondary" />
        </div>
        <div class="flex items-center border border-brand-outline-variant/30 rounded-xl bg-brand-surface-container-low p-1 text-xs">
          <button
            v-for="tf in typeFilters"
            :key="tf.v"
            @click="typeFilter = tf.v as 'ALL' | LogType; applySearch()"
            :class="['px-3 py-1 rounded-lg transition-all cursor-pointer',
              typeFilter === tf.v ? 'bg-white text-brand-primary font-bold shadow-sm' : 'text-brand-secondary hover:text-brand-on-surface']"
          >{{ tf.l }}</button>
        </div>
        <select
          v-model="levelFilter"
          @change="applySearch"
          class="text-xs border border-brand-outline-variant/30 rounded-xl px-3 py-2 bg-brand-surface-container-low text-brand-on-surface focus:outline-none focus:border-brand-primary cursor-pointer font-sans"
        >
          <option value="ALL">{{ t('logs.levelAll') }}</option>
          <option value="INFO">{{ t('logs.level.INFO') }}</option>
          <option value="WARN">{{ t('logs.level.WARN') }}</option>
          <option value="ERROR">{{ t('logs.level.ERROR') }}</option>
          <option value="FATAL">{{ t('logs.level.FATAL') }}</option>
        </select>
        <select
          v-model="timeRange"
          @change="applySearch"
          class="text-xs border border-brand-outline-variant/30 rounded-xl px-3 py-2 bg-brand-surface-container-low text-brand-on-surface focus:outline-none focus:border-brand-primary cursor-pointer font-sans"
        >
          <option value="15m">{{ t('logs.range.15m') }}</option>
          <option value="1h">{{ t('logs.range.1h') }}</option>
          <option value="6h">{{ t('logs.range.6h') }}</option>
          <option value="24h">{{ t('logs.range.24h') }}</option>
          <option value="custom">{{ t('logs.range.custom') }}</option>
        </select>
      </div>
      <button
        @click="exportConfirmOpen = true"
        :disabled="exporting"
        class="text-xs text-brand-on-surface-variant border border-brand-outline-variant hover:bg-brand-surface-container-low bg-white px-4 py-2 rounded-xl transition duration-200 cursor-pointer font-bold shrink-0 flex items-center gap-1.5 disabled:opacity-50"
      >
        <Download :size="14" :class="exporting ? 'animate-bounce' : ''" />
        <span>{{ exporting ? t('logs.exporting') : t('logs.exportCsv') }}</span>
      </button>
    </div>

    <!-- Logs table -->
    <div class="bg-white border border-brand-outline-variant/50 rounded-3xl overflow-hidden shadow-sm">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse table-auto">
          <thead>
            <tr class="bg-brand-surface-container-low/50 border-b border-brand-outline-variant/30 text-xs text-brand-secondary font-bold">
              <th class="px-6 py-4">{{ t('logs.col.type') }}</th>
              <th class="px-6 py-4">{{ t('logs.col.user') }}</th>
              <th class="px-6 py-4">{{ t('logs.col.timestamp') }}</th>
              <th class="px-6 py-4">{{ t('logs.col.level') }}</th>
              <th class="px-6 py-4">{{ t('logs.col.result') }}</th>
              <th class="px-6 py-4">{{ t('logs.col.summary') }}</th>
              <th class="px-6 py-4 text-right">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-brand-outline-variant/30 text-xs">
            <tr v-if="logs.length === 0">
              <td colspan="7" class="px-6 py-12 text-center text-brand-secondary">{{ t('logs.noData') }}</td>
            </tr>
            <tr v-for="log in logs" :key="log.id" class="hover:bg-brand-surface-container-low/30 transition duration-150">
              <td class="px-6 py-4 font-sans font-medium text-brand-on-surface-variant">
                <span :class="['px-2 py-0.5 rounded-md text-[10px] font-bold', typeBadgeClass(log.logType)]">{{ typeLabel[log.logType] ?? log.logType }}</span>
              </td>
              <td class="px-6 py-4 font-mono font-medium text-brand-on-surface">{{ operatorOf(log) }}</td>
              <td class="px-6 py-4 font-mono text-brand-secondary">{{ formatDateTime(log.createdAt) }}</td>
              <td class="px-6 py-4">
                <span :class="['inline-flex items-center gap-1 font-sans font-bold text-[10px] px-2 py-0.5 rounded-full', levelBadgeClass(log.level)]">
                  <component :is="log.level === 'INFO' ? Info : AlertCircle" :size="10" />
                  <span>{{ levelLabel[log.level] ?? log.level }}</span>
                </span>
              </td>
              <td class="px-6 py-4">
                <span :class="['font-sans font-bold text-[10px] px-2 py-0.5 rounded-full', resultBadgeClass(log.result)]">{{ resultLabel(log.result) }}</span>
              </td>
              <td class="px-6 py-4 font-sans text-brand-on-surface max-w-xs truncate font-medium">{{ log.message ?? '—' }}</td>
              <td class="px-6 py-4 text-right">
                <button @click="selectedLog = log" class="text-brand-primary hover:text-brand-primary-container font-bold flex items-center gap-1 ml-auto cursor-pointer">
                  <Eye :size="12" /><span>{{ t('common.viewDetail') }}</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- Pagination -->
      <div class="flex items-center justify-between px-6 py-3 border-t border-brand-outline-variant/30 text-xs text-brand-secondary">
        <span>{{ t('common.total', { n: total }) }}</span>
        <div class="flex items-center gap-2">
          <button @click="page = Math.max(1, page - 1); fetchLogs()" :disabled="page <= 1" class="px-3 py-1 border border-brand-outline-variant/40 rounded-lg disabled:opacity-40 hover:bg-brand-surface-container-low">{{ t('common.prevPage') }}</button>
          <span class="font-bold text-brand-on-surface">{{ page }} / {{ totalPages }}</span>
          <button @click="page = Math.min(totalPages, page + 1); fetchLogs()" :disabled="page >= totalPages" class="px-3 py-1 border border-brand-outline-variant/40 rounded-lg disabled:opacity-40 hover:bg-brand-surface-container-low">{{ t('common.nextPage') }}</button>
        </div>
      </div>
    </div>

    <!-- Detail modal -->
    <Teleport to="body">
      <div v-if="selectedLog" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in" @click.self="selectedLog = null">
        <div class="bg-white rounded-3xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
          <div class="bg-brand-surface-container-low px-6 py-4 border-b border-brand-outline-variant/30 flex justify-between items-center select-none">
            <div class="flex items-center gap-2">
              <FileText :size="18" class="text-brand-primary" />
              <h4 class="font-sans text-sm font-bold text-brand-on-surface">{{ t('logs.detailTitle') }}</h4>
            </div>
            <button @click="selectedLog = null" class="text-brand-secondary hover:text-brand-on-surface cursor-pointer p-0.5 rounded bg-brand-outline-variant/20 hover:bg-brand-outline-variant/40">
              <X :size="16" />
            </button>
          </div>
          <div class="p-6 overflow-y-auto custom-scrollbar space-y-4 text-xs">
            <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div class="p-3 bg-brand-surface-container-low rounded-xl">
                <p class="text-brand-secondary mb-0.5">{{ t('logs.featureModule') }}</p>
                <p class="font-bold text-brand-on-surface">{{ selectedLog.feature || t('logs.defaultModule') }}</p>
              </div>
              <div v-if="selectedLog.statusCode !== null" class="p-3 bg-brand-surface-container-low rounded-xl">
                <p class="text-brand-secondary mb-0.5">{{ t('logs.statusCode') }}</p>
                <p :class="['font-mono font-bold', (selectedLog.statusCode ?? 0) >= 400 ? 'text-brand-error' : 'text-emerald-600']">{{ t('logs.httpStatus') }} {{ selectedLog.statusCode }}</p>
              </div>
              <div class="p-3 bg-brand-surface-container-low rounded-xl">
                <p class="text-brand-secondary mb-0.5">{{ t('logs.operator') }}</p>
                <p class="font-mono font-bold text-brand-on-surface truncate">{{ selectedLog.operator ?? '—' }}</p>
              </div>
              <div v-if="selectedLog.fileInfo" class="p-3 bg-brand-surface-container-low rounded-xl col-span-2">
                <p class="text-brand-secondary mb-0.5">{{ t('logs.fileInfo') }}</p>
                <p class="font-mono font-bold text-brand-on-surface">{{ selectedLog.fileInfo }}</p>
              </div>
              <div v-if="selectedLog.action" class="p-3 bg-brand-surface-container-low rounded-xl">
                <p class="text-brand-secondary mb-0.5">{{ t('logs.action') }}</p>
                <p class="font-mono font-bold text-brand-on-surface">{{ selectedLog.action }}</p>
              </div>
              <div v-if="selectedLog.target" class="p-3 bg-brand-surface-container-low rounded-xl">
                <p class="text-brand-secondary mb-0.5">{{ t('logs.target') }}</p>
                <p class="font-mono font-bold text-brand-on-surface truncate">{{ selectedLog.target }}</p>
              </div>
              <div v-if="selectedLog.resultCategory" class="p-3 bg-brand-surface-container-low rounded-xl">
                <p class="text-brand-secondary mb-0.5">{{ t('logs.category') }}</p>
                <p class="font-bold text-brand-on-surface">{{ categoryLabel(selectedLog.resultCategory) }}</p>
              </div>
            </div>
            <div class="space-y-1.5">
              <p class="font-sans font-bold text-brand-on-surface">{{ t('logs.summaryLabel') }}</p>
              <div class="p-4 bg-brand-surface-container-low border border-brand-outline-variant/30 rounded-2xl font-sans font-medium text-brand-on-surface leading-relaxed">{{ selectedLog.message ?? '—' }}</div>
            </div>
            <div class="space-y-1.5">
              <p class="font-sans font-bold text-brand-on-surface">{{ t('logs.traceLabel') }}</p>
              <pre class="p-4 bg-brand-on-surface text-slate-100 rounded-2xl font-mono text-[10px] overflow-x-auto leading-relaxed select-text custom-scrollbar"><code>[{{ formatDateTime(selectedLog.createdAt) }}] [{{ selectedLog.level }}] MODULE: {{ (selectedLog.feature || 'CORE').toUpperCase() }}
STATUS: {{ (selectedLog.result ?? 'unknown').toUpperCase() }}
--------------------------------------------------------------------------------
TRACEBACK:
{{ selectedLog.stack || selectedLog.message || '—' }}

---- SYSTEM TELEMETRY EVENT LOGGED ----</code></pre>
            </div>
          </div>
          <div class="bg-brand-surface-container-low px-6 py-4 border-t border-brand-outline-variant/30 flex justify-end">
            <button @click="selectedLog = null" class="px-5 py-2 hover:bg-brand-surface-container-low border border-brand-outline-variant/40 text-[11px] font-bold text-brand-on-surface-variant rounded-xl cursor-pointer">{{ t('logs.endReview') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Export confirm dialog (PRD: 点导出 → 确认 → 下载) -->
    <Dialog :open="exportConfirmOpen" @update:open="exportConfirmOpen = $event">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle class="text-base font-bold text-stone-800">{{ t('logs.exportTitle') }}</DialogTitle>
          <DialogDescription class="text-xs text-stone-500">
            {{ t('logs.exportDesc') }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter class="flex gap-2 sm:justify-end">
          <Button variant="outline" size="sm" @click="exportConfirmOpen = false">{{ t('common.cancel') }}</Button>
          <Button size="sm" class="bg-[#2563eb] hover:bg-[#1d4ed8]" :disabled="exporting" @click="exportCsv">
            {{ exporting ? t('logs.exporting') : t('logs.confirmExport') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
