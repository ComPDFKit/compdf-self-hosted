/**
 * Public brand config, injected by SpaController as `window.COMPDF_CONFIG`.
 * On load, derives the 10-step brand color ramp (lib/theme.ts) and applies
 * dark mode. The admin can edit these values from the Settings page; a
 * full reload picks up the new config (logo gets a cache-buster `?v=`).
 */
import { defineStore } from 'pinia';
import { applyBrandTheme } from '@/lib/theme';

export interface BrandConfig {
  siteName: string;
  logoUrl: string | null;
  themeColor: string;
  locale: string;
  darkMode: boolean;
  upgradeBannerText: string | null;
  docUrl: string | null;
  contactUrl: string | null;
  compdfToolsEnabled: boolean;
  licenseType: 'UNKNOWN' | 'TRIAL' | 'FORMAL';
  licenseTypeValue: 0 | 1 | 2;
  isFormalLicense: boolean;
  /** Deployment API key plaintext — auto-attached as x-api-key by api/client.ts. */
  apiKey: string | null;
}

interface WindowWithBrand extends Window {
  COMPDF_CONFIG?: BrandConfig;
}

const FALLBACK: BrandConfig = {
  siteName: 'ComPDF Self-Hosted',
  logoUrl: null,
  themeColor: '#1668ff',
  locale: 'en',
  darkMode: false,
  upgradeBannerText: null,
  docUrl: null,
  contactUrl: null,
  compdfToolsEnabled: true,
  licenseType: 'UNKNOWN',
  licenseTypeValue: 0,
  isFormalLicense: false,
  apiKey: null,
};

const THEME_KEY = 'compdf-admin-theme';

export function getStoredTheme(): 'light' | 'dark' | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

export function storeTheme(mode: 'light' | 'dark'): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, mode);
}

export const useBrandStore = defineStore('brand', {
  state: () => ({
    config: null as BrandConfig | null,
    dark: false,
  }),
  getters: {
    c: (s): BrandConfig => s.config ?? FALLBACK,
    isDark: (s) => s.dark,
  },
  actions: {
    load() {
      this.config = (window as WindowWithBrand).COMPDF_CONFIG ?? null;
      const stored = getStoredTheme();
      this.dark = stored ? stored === 'dark' : this.c.darkMode;
      this.apply();
    },
    apply() {
      if (typeof document === 'undefined') return;
      applyBrandTheme(this.c.themeColor, this.dark ? 'dark' : 'light');
      document.documentElement.classList.toggle('dark', this.dark);
    },
    toggleTheme() {
      this.dark = !this.dark;
      this.apply();
      storeTheme(this.dark ? 'dark' : 'light');
    },
  },
});
