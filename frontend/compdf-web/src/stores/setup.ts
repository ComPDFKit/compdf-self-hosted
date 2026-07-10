/**
 * Default-login-hint store. The Dashboard login page calls check() to ask the
 * server whether the built-in admin credential hint should be shown. The
 * server keeps showing it until the deployment records its first successful
 * login.
 */
import { defineStore } from 'pinia';
import { http } from '@/api/client';

interface SetupStatus {
  needsSetup: boolean;
}

export const useSetupStore = defineStore('setup', {
  state: () => ({
    needsSetup: null as boolean | null,
  }),
  actions: {
    async check(): Promise<boolean> {
      const { data } = await http.get<SetupStatus>('/auth/setup-status');
      this.needsSetup = data.needsSetup;
      return data.needsSetup;
    },
  },
});
