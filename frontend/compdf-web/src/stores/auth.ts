/**
 * Admin auth store. The login endpoint returns
 * `{ token, username, role, mustChangePassword }` (8h JWT). The session is
 * persisted to localStorage and rehydrated on load; a 401 from any request
 * clears it and redirects to /admin/login (handled in api/client.ts).
 */
import { defineStore } from 'pinia';
import { http, loadSession, saveSession, clearSession, type StoredSession } from '@/api/client';

interface LoginResponse {
  token: string;
  username: string;
  role: string;
  mustChangePassword: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as StoredSession | null,
  }),
  getters: {
    isAuthenticated: (s) => !!s.session?.token,
    username: (s) => s.session?.username ?? '',
    role: (s) => s.session?.role ?? '',
    mustChangePassword: (s) => !!s.session?.mustChangePassword,
  },
  actions: {
    restore() {
      this.session = loadSession();
    },
    async login(username: string, password: string): Promise<LoginResponse> {
      const { data } = await http.post<LoginResponse>('/auth/login', { username, password });
      this.session = {
        token: data.token,
        username: data.username,
        role: data.role,
        mustChangePassword: data.mustChangePassword,
      };
      saveSession(this.session);
      return data;
    },
    async changePassword(oldPassword: string, newPassword: string): Promise<void> {
      await http.post('/auth/change-password', { oldPassword, newPassword });
      if (this.session) {
        this.session.mustChangePassword = false;
        saveSession(this.session);
      }
    },
    logout() {
      this.session = null;
      clearSession();
    },
  },
});
