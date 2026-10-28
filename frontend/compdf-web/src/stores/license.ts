/**
 * Display-only license payload, injected by SpaController as
 * `window.COMPDF_LICENSE` (sub/exp/status/present — NO raw token, NO limit
 * toggles). The frontend uses this ONLY to show an expiry overlay; it never
 * sends the token anywhere (the server attaches X-ComPDF-License upstream).
 */
import { defineStore } from 'pinia';
import type { LicenseDisplay } from '@/api/dashboard';

export type { LicenseDisplay } from '@/api/dashboard';

interface WindowWithLicense extends Window {
  COMPDF_LICENSE?: LicenseDisplay;
}

export const useLicenseStore = defineStore('license', {
  state: () => ({
    payload: null as LicenseDisplay | null,
  }),
  getters: {
    present: (s) => !!s.payload?.present,
    isExpired: (s) => s.payload?.status === 'expired',
    isExpiring: (s) => s.payload?.status === 'expiring',
  },
  actions: {
    load() {
      this.payload = (window as WindowWithLicense).COMPDF_LICENSE ?? null;
    },
  },
});
