import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css';
import App from './App.vue';
import { router } from './router';
import { useLicenseStore } from './stores/license';
import { useBrandStore } from '@/stores/brand';
import { useAuthStore } from '@/stores/auth';
import { i18n } from './i18n';
import { dashboardApi } from '@/api/dashboard';

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(router);

// Restore session + apply brand theme before mount — avoids a flash of the
// wrong color and a flash of the login page for already-authenticated users.
useLicenseStore().load(); // read injected window.COMPDF_LICENSE before mount
useBrandStore().load(); // read window.COMPDF_CONFIG, apply theme color + dark mode
useAuthStore().restore();

// Report non-API Web UI failures (uncaught errors / rejected promises) to the
// backend so they surface in the error logs. Throttled to 1/5s and best-effort
// (a network failure is swallowed). Only admin/dashboard sessions have a JWT,
// so reports are sent solely when the user is authenticated.
let lastReportAt = 0;
function reportClientError(message: string, stack?: string): void {
  if (!useAuthStore().isAuthenticated) return;
  const now = Date.now();
  if (now - lastReportAt < 5000) return; // throttle
  lastReportAt = now;
  void dashboardApi
    .reportClientError({ message: message.slice(0, 1000), stack: stack?.slice(0, 4000), context: window.location.pathname })
    .catch(() => {/* best-effort */});
}
app.config.errorHandler = (err, _instance, info) => {
  const e = err instanceof Error ? err : new Error(String(err));
  reportClientError(`${e.message} (${info})`, e.stack);
};
window.addEventListener('error', (ev) => {
  if (ev.error instanceof Error) reportClientError(ev.error.message, ev.error.stack);
  else if (ev.message) reportClientError(ev.message);
});
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  if (r instanceof Error) reportClientError(r.message, r.stack);
  else if (r) reportClientError(String(r));
});

app.mount('#app');
