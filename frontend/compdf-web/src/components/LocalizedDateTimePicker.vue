<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-vue-next';

const props = defineProps<{
  modelValue: string;
  locale: string;
  placeholder: string;
  clearLabel: string;
  todayLabel: string;
  previousMonthLabel: string;
  nextMonthLabel: string;
  hourLabel: string;
  minuteLabel: string;
}>();

const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>();

const picker = ref<HTMLElement>();
const open = ref(false);
onClickOutside(picker, () => {
  open.value = false;
});
const now = new Date();
const viewDate = ref(new Date(now.getFullYear(), now.getMonth(), 1));

function parseValue(value: string): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const selectedDate = computed(() => parseValue(props.modelValue));
const displayValue = computed(() => selectedDate.value
  ? new Intl.DateTimeFormat(props.locale.replace('_', '-'), {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(selectedDate.value)
  : props.placeholder);
const monthLabel = computed(() => new Intl.DateTimeFormat(props.locale.replace('_', '-'), {
  month: 'long', year: 'numeric',
}).format(viewDate.value));
const weekdayLabels = computed(() => {
  const formatter = new Intl.DateTimeFormat(props.locale.replace('_', '-'), { weekday: 'short' });
  return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2024, 0, 1 + index)));
});
const daysInMonth = computed(() => new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + 1, 0).getDate());
const firstWeekday = computed(() => (new Date(viewDate.value.getFullYear(), viewDate.value.getMonth(), 1).getDay() + 6) % 7);
const calendarCells = computed(() => [
  ...Array.from({ length: firstWeekday.value }, () => null as number | null),
  ...Array.from({ length: daysInMonth.value }, (_, index) => index + 1),
]);
const hour = computed(() => selectedDate.value?.getHours() ?? 0);
const minute = computed(() => selectedDate.value?.getMinutes() ?? 0);

function toggle() {
  if (!open.value) {
    const date = selectedDate.value ?? new Date();
    viewDate.value = new Date(date.getFullYear(), date.getMonth(), 1);
  }
  open.value = !open.value;
}

function changeMonth(offset: number) {
  viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + offset, 1);
}

function selectDay(day: number) {
  const current = selectedDate.value ?? new Date();
  emit('update:modelValue', formatValue(new Date(viewDate.value.getFullYear(), viewDate.value.getMonth(), day, current.getHours(), current.getMinutes())));
}

function updateTime(kind: 'hour' | 'minute', value: string) {
  const current = selectedDate.value ?? new Date();
  if (!selectedDate.value) {
    current.setSeconds(0, 0);
  }
  if (kind === 'hour') current.setHours(Number(value));
  else current.setMinutes(Number(value));
  emit('update:modelValue', formatValue(current));
}

function clear() {
  emit('update:modelValue', '');
}

function selectToday() {
  const current = selectedDate.value ?? new Date();
  const today = new Date();
  today.setHours(current.getHours(), current.getMinutes(), 0, 0);
  emit('update:modelValue', formatValue(today));
  viewDate.value = new Date(today.getFullYear(), today.getMonth(), 1);
}

watch(() => props.modelValue, (value) => {
  const date = parseValue(value);
  if (date && !open.value) viewDate.value = new Date(date.getFullYear(), date.getMonth(), 1);
});
</script>

<template>
  <div ref="picker" class="relative">
    <button
      type="button"
      class="flex h-9 min-w-[11rem] items-center gap-2 rounded-xl border border-brand-outline-variant/30 bg-brand-surface-container-low px-2 text-left text-xs text-brand-on-surface focus:border-brand-primary focus:outline-none"
      :aria-expanded="open"
      @click="toggle"
    >
      <CalendarDays :size="14" class="shrink-0 text-brand-secondary" />
      <span class="truncate" :class="selectedDate ? '' : 'text-brand-secondary'">{{ displayValue }}</span>
    </button>
    <div v-if="open" class="absolute z-50 mt-2 w-[19rem] rounded-xl border border-brand-outline-variant/30 bg-white p-3 shadow-xl">
      <div class="mb-2 flex items-center justify-between gap-2">
        <button type="button" class="rounded-lg p-1 text-brand-secondary hover:bg-brand-surface-container-low" :aria-label="previousMonthLabel" @click="changeMonth(-1)">
          <ChevronLeft :size="16" />
        </button>
        <span class="text-sm font-semibold text-brand-on-surface">{{ monthLabel }}</span>
        <button type="button" class="rounded-lg p-1 text-brand-secondary hover:bg-brand-surface-container-low" :aria-label="nextMonthLabel" @click="changeMonth(1)">
          <ChevronRight :size="16" />
        </button>
      </div>
      <div class="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-brand-secondary">
        <span v-for="weekday in weekdayLabels" :key="weekday">{{ weekday }}</span>
      </div>
      <div class="mt-1 grid grid-cols-7 gap-1 text-center text-xs">
        <span v-for="(day, index) in calendarCells" :key="`${day ?? 'empty'}-${index}`" class="h-7" :class="day ? 'flex items-center justify-center' : ''">
          <button
            v-if="day"
            type="button"
            class="h-7 w-7 rounded-lg hover:bg-brand-surface-container-low"
            :class="selectedDate && selectedDate.getFullYear() === viewDate.getFullYear() && selectedDate.getMonth() === viewDate.getMonth() && selectedDate.getDate() === day ? 'bg-brand-primary text-white' : 'text-brand-on-surface'"
            @click="selectDay(day)"
          >{{ day }}</button>
        </span>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-2">
        <label class="flex items-center gap-1 text-[11px] text-brand-secondary">
          <span>{{ hourLabel }}</span>
          <select class="h-8 min-w-0 flex-1 rounded-lg border border-brand-outline-variant/30 bg-white px-1 text-xs text-brand-on-surface" :value="String(hour).padStart(2, '0')" @change="updateTime('hour', ($event.target as HTMLSelectElement).value)">
            <option v-for="value in 24" :key="value - 1" :value="String(value - 1).padStart(2, '0')">{{ String(value - 1).padStart(2, '0') }}</option>
          </select>
        </label>
        <label class="flex items-center gap-1 text-[11px] text-brand-secondary">
          <span>{{ minuteLabel }}</span>
          <select class="h-8 min-w-0 flex-1 rounded-lg border border-brand-outline-variant/30 bg-white px-1 text-xs text-brand-on-surface" :value="String(minute).padStart(2, '0')" @change="updateTime('minute', ($event.target as HTMLSelectElement).value)">
            <option v-for="value in 60" :key="value - 1" :value="String(value - 1).padStart(2, '0')">{{ String(value - 1).padStart(2, '0') }}</option>
          </select>
        </label>
      </div>
      <div class="mt-3 flex justify-between border-t border-brand-outline-variant/20 pt-2 text-xs">
        <button type="button" class="text-brand-secondary hover:text-brand-primary" @click="clear">{{ clearLabel }}</button>
        <button type="button" class="text-brand-primary hover:underline" @click="selectToday">{{ todayLabel }}</button>
      </div>
    </div>
  </div>
</template>
