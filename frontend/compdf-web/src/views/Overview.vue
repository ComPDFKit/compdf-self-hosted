<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, TrendingUp, Clock, AlertCircle, XCircle } from 'lucide-vue-next';
import { dashboardApi, type Overview, type OverviewRange, type TrendPoint } from '@/api/dashboard';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const { t } = useI18n();
const data = ref<Overview | null>(null);
const selectedRange = ref<OverviewRange>('week');
const hoveredIndex = ref<number | null>(null);

onMounted(() => {
  loadOverview();
});

const countMetricKeys = ['success', 'invalid', 'fail', 'exception', 'errorTotal'] as const;
type CountMetricKey = typeof countMetricKeys[number];
type TrendMetricKey = CountMetricKey | 'avgSuccessDurationMs';

const trendMetrics = computed(() => [
  { key: 'success' as const, label: t('overview.success'), color: '#2563eb' },
  { key: 'avgSuccessDurationMs' as const, label: t('overview.avgSuccessDuration'), color: '#34d399', unit: 'ms' as const },
]);
const rangeOptions = computed(() => [
  { value: '24h' as const, label: t('overview.range.24h') },
  { value: 'week' as const, label: t('overview.range.week') },
  { value: 'month' as const, label: t('overview.range.month') },
]);

const trendPoints = computed(() => data.value?.trend7d ?? []);
const hoveredPoint = computed(() => {
  if (hoveredIndex.value === null) return null;
  return trendPoints.value[hoveredIndex.value] ?? null;
});
const countMax = computed(() => Math.max(
  1,
  ...trendPoints.value.flatMap((point) => countMetricKeys.map((key) => trendValue(point, key))),
));
const durationMax = computed(() => Math.max(
  1,
  ...trendPoints.value.map((point) => trendValue(point, 'avgSuccessDurationMs')),
));

async function loadOverview() {
  data.value = await dashboardApi.overview({ range: selectedRange.value });
  hoveredIndex.value = null;
}

async function selectRange(range: OverviewRange) {
  if (selectedRange.value === range) return;
  selectedRange.value = range;
  await loadOverview();
}

async function onRangeUpdate(value: unknown) {
  if (value === '24h' || value === 'week' || value === 'month') {
    await selectRange(value);
  }
}

function trendValue(point: TrendPoint, key: TrendMetricKey) {
  const value = point[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function trendPathFor(key: TrendMetricKey) {
  const pts = trendPoints.value;
  if (pts.length === 0) return '';
  const max = key === 'avgSuccessDurationMs' ? durationMax.value : countMax.value;
  const w = 1000, h = 220, pad = 50;
  const step = (w - pad * 2) / Math.max(1, pts.length - 1);
  return pts
    .map((p, i) => {
      const x = pad + i * step;
      const y = h - 28 - (trendValue(p, key) / max) * (h - 64);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function formatTrendDate(date: string) {
  if (date.includes(' ')) return `${date.slice(5, 10)} ${date.slice(11, 16)}`;
  const parts = date.split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : date;
}

function formatMetricValue(point: TrendPoint, metric: { key: TrendMetricKey; unit?: 'ms' }) {
  const value = trendValue(point, metric.key);
  return metric.unit === 'ms' ? `${value}ms` : String(value);
}

function hoverLeft(index: number) {
  const total = Math.max(1, trendPoints.value.length - 1);
  return `${(index / total) * 100}%`;
}
</script>

<template>
  <div data-test="overview-root" class="space-y-6 max-w-7xl mx-auto px-4 md:px-0 animate-fade-in font-sans">
    <!-- 今日数据 (PRD §5: 成功/无效/失败/异常 + 错误总数 + 成功平均耗时) -->
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
      <div class="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs hover:shadow-sm transition">
        <div class="flex items-center gap-2 mb-2 text-stone-500 text-xs font-semibold">
          <Check :size="14" class="text-[#10b981]" /> {{ t('overview.success') }}
        </div>
        <p data-test="overview-success-card" class="text-2xl font-extrabold text-stone-900">{{ data?.today.success ?? '—' }}</p>
      </div>
      <div class="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs hover:shadow-sm transition">
        <div class="flex items-center gap-2 mb-2 text-stone-500 text-xs font-semibold">
          <AlertCircle :size="14" class="text-[#f59e0b]" /> {{ t('overview.invalid') }}
        </div>
        <p class="text-2xl font-extrabold text-stone-900">{{ data?.today.invalid ?? '—' }}</p>
      </div>
      <div class="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs hover:shadow-sm transition">
        <div class="flex items-center gap-2 mb-2 text-stone-500 text-xs font-semibold">
          <XCircle :size="14" class="text-[#ef4444]" /> {{ t('overview.fail') }}
        </div>
        <p class="text-2xl font-extrabold text-stone-900">{{ data?.today.fail ?? '—' }}</p>
      </div>
      <div class="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs hover:shadow-sm transition">
        <div class="flex items-center gap-2 mb-2 text-stone-500 text-xs font-semibold">
          <AlertCircle :size="14" class="text-[#ef4444]" /> {{ t('overview.exception') }}
        </div>
        <p class="text-2xl font-extrabold text-stone-900">{{ data?.today.exception ?? '—' }}</p>
      </div>
      <div class="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs hover:shadow-sm transition">
        <div class="flex items-center gap-2 mb-2 text-stone-500 text-xs font-semibold">
          <TrendingUp :size="14" class="text-[#ef4444]" /> {{ t('overview.errorTotal') }}
        </div>
        <p class="text-2xl font-extrabold text-stone-900">{{ data?.today.errorTotal ?? '—' }}</p>
      </div>
      <div class="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs hover:shadow-sm transition">
        <div class="flex items-center gap-2 mb-2 text-stone-500 text-xs font-semibold">
          <Clock :size="14" class="text-[#2563eb]" /> {{ t('overview.avgSuccessDuration') }}
        </div>
        <p class="text-2xl font-extrabold text-stone-900">{{ data?.today.avgSuccessDurationMs != null ? data.today.avgSuccessDurationMs + 'ms' : '—' }}</p>
      </div>
    </div>

    <!-- 3. 趋势图 -->
    <div class="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs hover:shadow-sm transition">
      <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
        <div class="flex items-center gap-2">
          <TrendingUp :size="16" class="text-brand-primary" />
          <h3 class="text-sm font-bold text-stone-800">{{ t('overview.trendTitle') }}</h3>
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
          <div class="flex flex-wrap gap-x-4 gap-y-2">
            <div
              v-for="metric in trendMetrics"
              :key="metric.key"
              class="flex items-center gap-1.5 text-[11px] font-semibold text-stone-500"
            >
              <span class="w-2.5 h-2.5 rounded-full" :style="{ backgroundColor: metric.color }" />
              <span>{{ metric.label }}</span>
            </div>
          </div>
          <Select :model-value="selectedRange" @update:model-value="onRangeUpdate">
            <SelectTrigger data-test="overview-range-select" class="h-9 w-[148px] rounded-xl border-slate-200 bg-slate-50 text-xs font-semibold text-stone-700 shadow-xs">
              <SelectValue class="text-xs" :placeholder="t('overview.range.placeholder')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="option in rangeOptions"
                :key="option.value"
                :value="option.value"
                class="text-xs"
                :data-test="`overview-range-${option.value === '24h' ? '24h' : option.value}`"
              >
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div data-test="overview-trend-chart" class="w-full bg-slate-50/20 border border-slate-100 rounded-xl p-4">
        <div class="relative h-56 w-full flex flex-col justify-between">
          <div class="flex-1 relative min-h-0">
            <svg class="w-full h-full overflow-visible" viewBox="0 0 1000 220" preserveAspectRatio="none">
              <line x1="50" y1="192" x2="950" y2="192" stroke="#e2e8f0" stroke-width="1" />
              <line x1="50" y1="114" x2="950" y2="114" stroke="#f1f5f9" stroke-width="1" />
              <line x1="50" y1="36" x2="950" y2="36" stroke="#f1f5f9" stroke-width="1" />
              <path
                v-for="metric in trendMetrics"
                :key="metric.key"
                data-test="overview-trend-line"
                :d="trendPathFor(metric.key)"
                fill="none"
                :stroke="metric.color"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <rect
                v-for="(_point, index) in trendPoints"
                :key="`hit-${index}`"
                :data-test="`overview-trend-hit-${index}`"
                :x="50 + index * (900 / Math.max(1, trendPoints.length - 1)) - (450 / Math.max(1, trendPoints.length))"
                y="0"
                :width="900 / Math.max(1, trendPoints.length)"
                height="220"
                fill="transparent"
                @mouseenter="hoveredIndex = index"
                @mouseleave="hoveredIndex = null"
              />
            </svg>
            <div
              v-if="hoveredPoint !== null && hoveredIndex !== null"
              data-test="overview-trend-tooltip"
              class="pointer-events-none absolute top-2 min-w-[190px] -translate-x-1/2 rounded-lg border border-slate-200 bg-white/95 p-3 text-xs shadow-lg"
              :style="{ left: hoverLeft(hoveredIndex) }"
            >
              <div class="font-bold text-stone-800 mb-2">{{ formatTrendDate(hoveredPoint.date) }}</div>
              <div
                v-for="metric in trendMetrics"
                :key="`tooltip-${metric.key}`"
                class="flex items-center justify-between gap-4 py-0.5 text-stone-600"
              >
                <span class="inline-flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full" :style="{ backgroundColor: metric.color }" />
                  {{ metric.label }}
                </span>
                <span class="font-bold text-stone-900">{{ formatMetricValue(hoveredPoint, metric) }}</span>
              </div>
            </div>
          </div>
          <div
            class="grid items-center px-4 mt-2 border-t border-slate-100 pt-3"
            :style="{ gridTemplateColumns: `repeat(${trendPoints.length || 1}, minmax(0, 1fr))` }"
          >
            <span
              v-for="point in trendPoints"
              :key="point.date"
              class="text-[11px] font-semibold text-stone-400 text-center"
            >
              {{ formatTrendDate(point.date) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
