<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { LayoutDashboard, RefreshCw, ScrollText, UserCheck, Settings, KeyRound, Braces, Server } from 'lucide-vue-next';
import { DEFAULT_LOGO_URL, useBrandStore } from '@/stores/brand';

const { t } = useI18n();
const brand = useBrandStore();

defineProps<{ mobileOpen?: boolean }>();
const emit = defineEmits<{ navigate: [] }>();

const systemItems = [
  { to: { name: 'overview' }, icon: LayoutDashboard, labelKey: 'nav.overview' as const },
  { to: { name: 'license' }, icon: KeyRound, labelKey: 'nav.licenseManagement' as const },
  { to: { name: 'api-keys' }, icon: Braces, labelKey: 'nav.apiManagement' as const },
  { to: { name: 'mcp' }, icon: Server, labelKey: 'nav.mcp' as const },
  { to: { name: 'logs' }, icon: ScrollText, labelKey: 'nav.logs' as const },
  { to: { name: 'updates' }, icon: RefreshCw, labelKey: 'nav.updates' as const },
  { to: { name: 'account' }, icon: UserCheck, labelKey: 'nav.account' as const },
  { to: { name: 'settings' }, icon: Settings, labelKey: 'nav.settings' as const },
];
</script>

<template>
  <aside
    class="fixed left-0 top-0 z-40 flex h-full w-[240px] shrink-0 -translate-x-full select-none flex-col border-r border-brand-outline-variant/50 bg-white py-6 transition-transform duration-200 md:translate-x-0"
    :class="{ '!translate-x-0': mobileOpen }"
  >
    <!-- Brand -->
    <div class="px-6 mb-8 flex items-center gap-3">
      <img :src="brand.c.logoUrl ?? DEFAULT_LOGO_URL" alt="" class="w-8 h-8" />
      <h1 class="font-sans text-lg font-bold text-brand-on-surface leading-tight truncate">
        {{ brand.c.siteName || 'ComPDF Engine' }}
      </h1>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 space-y-4 overflow-y-auto custom-scrollbar">
      <div class="space-y-1">
        <span class="text-stone-400 font-bold uppercase tracking-wider text-[10px] px-6 py-1 block">
          {{ t('sidebar.systemControl') }}
        </span>
        <RouterLink
          v-for="item in systemItems"
          :key="item.labelKey"
          :to="item.to"
          class="w-full flex items-center gap-3 px-6 py-3 text-left transition-all duration-200 text-brand-secondary hover:bg-brand-surface-container-low hover:text-brand-on-surface"
          exact-active-class="!bg-brand-secondary-container !text-brand-primary !border-l-4 !border-brand-primary !font-medium"
          @click="emit('navigate')"
        >
          <component :is="item.icon" :size="18" class="shrink-0" />
          <span class="font-sans text-sm">{{ t(item.labelKey) }}</span>
        </RouterLink>
      </div>
    </nav>
  </aside>
</template>
