<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ShieldCheck, RefreshCw, Palette, Globe2, Check, FileCode, ArrowRight,
} from 'lucide-vue-next';
import { dashboardApi, type BrandSettings, type VersionInfo } from '@/api/dashboard';
import { toApiError } from '@/api/client';
import { useBrandStore } from '@/stores/brand';
import { DASHBOARD_LANGUAGES, setLocale } from '@/i18n';
import {
  dashboardLocaleToSettingsValue,
  settingsValueToDashboardLocale,
} from '@/config/i18n-keys';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const { t } = useI18n();
const brand = useBrandStore();
const form = ref<BrandSettings | null>(null);
const version = ref<VersionInfo | null>(null);
const saveFinished = ref(false);
const saveError = ref<string | null>(null);
const checkingUpdate = ref(false);
const logoFile = ref<File | null>(null);
// Logo preview URL — tracks the configured logo; null (→ FileCode icon) when
// no logo is configured or the image fails to load.
const logoPreviewUrl = ref<string | null>(null);

const themeColors = [
  { name: 'Blue', hex: '#0E48D8' },
  { name: 'Green', hex: '#00644e' },
  { name: 'Red', hex: '#ba1a1a' },
  { name: 'Purple', hex: '#5c5d6f' },
  { name: 'Dark', hex: '#202124' },
];

// The Select reflects the SAVED brand locale (not the live UI locale) so that
// re-entering Settings shows what was persisted. setLocale is only called on a
// successful save — mount must NOT switch the UI language.
const settingsLocale = ref('en');

onMounted(async () => {
  const settings = await dashboardApi.getSettings();
  settingsLocale.value = dashboardLocaleToSettingsValue(settingsValueToDashboardLocale(settings.locale));
  form.value = {
    ...settings,
    locale: settingsLocale.value,
  };
  logoPreviewUrl.value = brand.c.logoUrl;
  version.value = await dashboardApi.version();
});

async function saveConfig() {
  if (!form.value) return;
  const currentSettingsLocale = settingsLocale.value;
  saveError.value = null;
  try {
    const updated = await dashboardApi.updateSettings({
      siteName: form.value.siteName,
      themeColor: form.value.themeColor,
      locale: currentSettingsLocale,
    });
    form.value = {
      ...updated,
      locale: currentSettingsLocale,
    };
    // Reflect into the brand store + re-apply theme so the sidebar/header update live.
    brand.config = {
      ...brand.c,
      siteName: updated.siteName,
      logoUrl: brand.c.logoUrl,
      themeColor: updated.themeColor,
      locale: currentSettingsLocale,
      darkMode: updated.darkMode,
      upgradeBannerText: updated.upgradeBannerText,
      docUrl: updated.docUrl,
      contactUrl: updated.contactUrl,
    };
    brand.apply();
    setLocale(settingsValueToDashboardLocale(currentSettingsLocale));
    saveFinished.value = true;
    setTimeout(() => (saveFinished.value = false), 2000);
  } catch (err) {
    saveError.value = (await toApiError(err)).message;
  }
}

async function onLogoChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  logoFile.value = file;
  const updated = await dashboardApi.uploadLogo(file);
  form.value = updated;
  const url = updated.logoPath ? `/api/v1/dashboard/branding/logo?v=${Date.now()}` : null;
  logoPreviewUrl.value = url;
  if (brand.config) brand.config.logoUrl = url;
}

async function checkSoftwareUpdate() {
  checkingUpdate.value = true;
  try {
    version.value = await dashboardApi.version();
  } finally {
    checkingUpdate.value = false;
  }
}

</script>

<template>
  <div v-if="form" class="space-y-6 max-w-7xl mx-auto pb-12">
    <!-- Save button -->
    <div class="flex justify-end items-center select-none pb-2">
      <button
        data-test="settings-save"
        @click="saveConfig"
        class="bg-brand-primary hover:opacity-90 text-white text-xs font-bold px-6 py-2.5 rounded-lg shadow-sm transition flex items-center gap-1.5 cursor-pointer"
      >
        <Check v-if="saveFinished" :size="14" />
        <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
        <span>{{ saveFinished ? t('settings.saved') : t('settings.save') }}</span>
      </button>
    </div>
    <p v-if="saveError" data-test="settings-save-error" class="-mt-4 text-xs font-medium text-red-600 text-right">
      {{ saveError }}
    </p>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
      <!-- Left: brand settings -->
      <div class="space-y-6">
        <div class="bg-white border border-brand-outline-variant/60 rounded-2xl p-6 space-y-5 shadow-2xs hover:shadow-xs transition duration-200">
          <div class="flex items-center gap-2 select-none border-b border-stone-50 pb-3">
            <Palette :size="18" class="text-brand-primary" />
            <h3 class="font-sans text-base font-bold text-stone-800">{{ t('settings.brand') }}</h3>
          </div>

          <div class="space-y-1.5">
            <label class="text-xs text-stone-500 font-medium select-none">{{ t('settings.siteName') }}</label>
            <input
              v-model="form.siteName"
              type="text"
              class="w-full text-xs text-stone-800 border border-brand-outline-variant/60 rounded-lg px-3 py-2.5 focus:outline-none focus:border-brand-primary bg-transparent font-sans transition duration-150"
            />
          </div>

          <div class="space-y-1.5">
            <label class="text-xs text-stone-500 font-medium select-none">{{ t('settings.logo') }}</label>
            <div class="flex items-center justify-between p-3.5 bg-indigo-50/50 border border-indigo-100 rounded-xl">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 overflow-hidden bg-brand-primary text-white">
                  <img v-if="logoPreviewUrl" :src="logoPreviewUrl" :alt="t('settings.logo')" class="w-full h-full object-contain" @error="logoPreviewUrl = null" />
                  <FileCode v-else :size="20" />
                </div>
                <div>
                  <p class="text-xs font-bold text-stone-800">{{ logoFile?.name ?? form.logoPath ?? 'logo.svg' }}</p>
                  <p class="text-[10px] text-stone-400">{{ t('settings.logoHint') }}</p>
                </div>
              </div>
              <label class="text-xs font-bold text-brand-primary hover:opacity-80 cursor-pointer bg-white border border-stone-200 px-3 py-1.5 rounded-lg shadow-2xs transition">
                {{ t('settings.change') }}
                <input type="file" accept="image/png,image/svg+xml" class="hidden" @change="onLogoChange" />
              </label>
            </div>
          </div>

          <div class="space-y-2">
            <label class="text-xs text-stone-500 font-medium block select-none">{{ t('settings.themeColor') }}</label>
            <div class="flex items-center justify-between bg-slate-50/55 p-2.5 px-3.5 border border-stone-100 rounded-lg">
              <div class="flex items-center gap-3">
                <button
                  v-for="tc in themeColors"
                  :key="tc.name"
                  type="button"
                  @click="form.themeColor = tc.hex"
                  :class="['w-5.5 h-5.5 rounded-full border transition-all cursor-pointer relative flex items-center justify-center',
                    form.themeColor.toUpperCase() === tc.hex.toUpperCase() ? 'scale-110 shadow-sm ring-2 ring-blue-500/20' : 'hover:scale-105']"
                  :style="{ backgroundColor: tc.hex, borderColor: 'rgba(0,0,0,0.08)' }"
                >
                  <span v-if="form.themeColor.toUpperCase() === tc.hex.toUpperCase()" class="absolute inset-0 m-auto w-1.5 h-1.5 bg-white rounded-full" />
                </button>
              </div>
              <div class="flex items-center gap-2 select-none">
                <span class="w-3.5 h-3.5 rounded border border-stone-200" :style="{ backgroundColor: form.themeColor }" />
                <span class="text-xs font-mono font-bold text-stone-800 uppercase">{{ form.themeColor }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Right: version + language -->
      <div class="space-y-6">
        <div class="bg-white border border-brand-outline-variant/60 rounded-2xl p-6 flex flex-col justify-between shadow-2xs hover:shadow-xs transition duration-200">
          <div>
            <div class="flex justify-between items-center mb-6 select-none">
              <div class="flex items-center gap-2">
                <ShieldCheck :size="18" class="text-brand-primary" />
                <h3 class="font-sans text-base font-bold text-stone-800">{{ t('settings.versionTitle') }}</h3>
              </div>
              <span v-if="version?.updateAvailable" class="bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-bold px-2 py-0.5 rounded">{{ t('settings.updateAvailable') }}</span>
              <span v-else class="bg-[#ecfdf5] text-[#12b76a] border border-[#d1fae5] text-[11px] font-bold px-2 py-0.5 rounded">{{ t('settings.stable') }}</span>
            </div>
            <div class="space-y-4">
              <div>
                <p class="text-xs text-stone-400 font-medium select-none mb-1">{{ t('settings.currentVersion') }}</p>
                <p class="text-3xl font-bold text-brand-primary tracking-tight font-sans">v{{ version?.current ?? '—' }}</p>
              </div>
              <div v-if="version?.updateAvailable && version.latest" class="p-3.5 bg-amber-50/60 border border-amber-200/60 rounded-xl space-y-1.5">
                <p class="text-xs font-bold text-amber-800">{{ t('settings.latestAvailable', { version: version.latest }) }}</p>
                <p v-if="version.releasedAt" class="text-[10px] text-amber-700/80">{{ t('settings.releasedAt', { date: version.releasedAt.slice(0, 10) }) }}</p>
                <p class="text-[10px] text-stone-500 mt-1">{{ t('settings.upgradeCommand') }} <code class="font-mono bg-white px-1.5 py-0.5 rounded border border-stone-200">docker compose pull && docker compose up -d</code></p>
                <a v-if="version.changelogUrl" :href="version.changelogUrl" target="_blank" rel="noopener" class="text-[11px] font-bold text-brand-primary hover:underline inline-flex items-center gap-1 mt-1">
                  {{ t('settings.viewChangelog') }} <ArrowRight :size="12" />
                </a>
              </div>
              <div v-else-if="version && !version.updateAvailable" class="p-3.5 bg-emerald-50/40 border border-emerald-200/50 rounded-xl">
                <p class="text-xs font-bold text-emerald-700">{{ t('settings.upToDate') }}</p>
              </div>
              <div v-else class="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                <p class="text-xs text-stone-500">{{ t('settings.updateCheckFailed') }}</p>
              </div>
            </div>
          </div>
          <button
            @click="checkSoftwareUpdate"
            :disabled="checkingUpdate"
            class="w-full mt-6 bg-brand-primary hover:opacity-90 text-white py-3 rounded-lg text-xs font-bold font-sans transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-75"
          >
            <RefreshCw :size="13" :class="checkingUpdate ? 'animate-spin' : ''" />
            <span>{{ checkingUpdate ? t('settings.checking') : t('settings.checkUpdate') }}</span>
          </button>
        </div>

        <div class="bg-white border border-brand-outline-variant/60 rounded-2xl p-6 space-y-4 shadow-2xs hover:shadow-xs transition duration-200">
          <div class="flex items-center gap-2 select-none border-b border-stone-50 pb-3">
            <Globe2 :size="18" class="text-brand-primary" />
            <h3 class="font-sans text-base font-bold text-stone-800">{{ t('settings.languageTitle') }}</h3>
          </div>
          <div class="space-y-1.5">
            <label class="text-xs text-stone-500 font-medium select-none">{{ t('settings.selectLanguage') }}</label>
            <Select v-model="settingsLocale">
              <SelectTrigger data-test="settings-locale-select" class="w-full text-xs text-stone-800 border-brand-outline-variant/60 rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="lang in DASHBOARD_LANGUAGES"
                  :key="lang.code"
                  :value="lang.settingsValue"
                >
                  {{ lang.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p class="text-[11px] text-stone-400 select-none">{{ t('settings.languageHint') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
