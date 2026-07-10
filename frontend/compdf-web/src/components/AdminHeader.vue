<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { LogOut, ChevronDown, Home } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toolsEnabled = window.COMPDF_CONFIG?.compdfToolsEnabled !== false;

const logoutOpen = ref(false);

const titleMap: Record<string, string> = {
  overview: 'nav.overview',
  logs: 'nav.logs',
  account: 'nav.account',
  settings: 'nav.settings',
};

const pageTitle = computed(() => t(titleMap[String(route.name ?? '')] ?? 'nav.overview'));

function confirmLogout() {
  logoutOpen.value = false;
  auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <header
    class="h-[59px] bg-white border-b border-brand-outline-variant/50 sticky top-0 px-8 flex items-center justify-between z-30 select-none"
  >
    <!-- Breadcrumb -->
    <div class="flex items-center gap-2 text-xs text-brand-secondary">
      <span>{{ t('header.console') }}</span>
      <span>/</span>
      <span class="text-brand-on-surface-variant font-medium">{{ pageTitle }}</span>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-4">
      <template v-if="toolsEnabled">
        <Button
          as="a"
          href="/"
          variant="outline"
          size="sm"
          class="text-xs font-bold text-brand-primary border-slate-200 hover:border-brand-primary hover:bg-brand-surface-container-low bg-white gap-1.5 h-8"
        >
          <Home :size="12" />
          <span>{{ t('header.demo') }}</span>
        </Button>

        <div class="h-6 w-[1px] bg-slate-100 hidden md:block" />
      </template>

      <!-- Avatar dropdown -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            class="flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-slate-50 transition border border-transparent hover:border-slate-100 text-left"
          >
            <div
              class="w-8 h-8 rounded-full bg-brand-primary-container text-brand-primary flex items-center justify-center font-bold text-xs border border-brand-outline-variant/30"
            >
              {{ auth.username.charAt(0).toUpperCase() || 'A' }}
            </div>
            <div class="hidden md:block select-none">
              <p class="text-xs font-bold text-stone-800 leading-none">{{ auth.username || 'Admin' }}</p>
              <p class="text-[9px] text-stone-400 mt-0.5">{{ t('header.adminRole') }}</p>
            </div>
            <ChevronDown :size="14" class="text-stone-400" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-56">
          <DropdownMenuLabel class="text-xs font-extrabold text-stone-800">
            {{ auth.username || 'Admin User' }}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="text-red-600 hover:bg-red-50" @select="logoutOpen = true">
            <LogOut :size="14" class="text-red-500" />
            <span class="text-xs font-bold">{{ t('header.logout') }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- Logout confirmation dialog -->
    <Dialog :open="logoutOpen" @update:open="logoutOpen = $event">
      <DialogContent class="max-w-sm text-center select-none overflow-hidden p-6">
        <div class="mx-auto w-12 h-12 rounded-full bg-red-50 border border-red-100 flex items-center justify-center text-red-600 mb-4">
          <LogOut :size="20" />
        </div>
        <DialogHeader>
          <DialogTitle class="text-lg font-bold text-stone-800">{{ t('header.logoutConfirmTitle') }}</DialogTitle>
          <DialogDescription class="text-xs text-stone-500 leading-relaxed px-2">
            {{ t('header.logoutConfirmDesc') }}
          </DialogDescription>
        </DialogHeader>
        <div class="grid grid-cols-2 gap-3 mt-6">
          <Button variant="outline" class="border-slate-200 hover:bg-slate-50 text-stone-600 font-semibold text-xs h-10" @click="logoutOpen = false">
            {{ t('common.cancel') }}
          </Button>
          <Button class="bg-[#ef4444] hover:bg-[#dc2626] text-white font-semibold text-xs h-10" @click="confirmLogout">
            {{ t('header.confirmLogout') }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </header>
</template>
