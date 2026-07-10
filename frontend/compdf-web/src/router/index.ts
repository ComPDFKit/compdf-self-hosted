import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

/**
 * Unified router — public ComPDF Web demo routes (`/`, `/pdf-tools/*`) + admin
 * Dashboard routes (`/admin/*`). Base history is `/` (no `/admin/` prefix); the
 * admin SPA owns `/admin/*` explicitly.
 *
 * Routing gates:
 *   - Web demo routes: public SPA routes. No client-side auth — the API key is
 *     auto-injected from window.COMPDF_CONFIG.
 *   - Admin routes: JwtAuthGuard-equivalent client check (auth store) plus
 *     first-login forced password change.
 */
const routes: RouteRecordRaw[] = [
  // ---- Web demo (public PDF tool demo) ----
  {
    path: '/',
    component: () => import('@/layouts/WebLayout.vue'),
    children: [
      { path: '', name: 'catalog', component: () => import('@/views/ToolCatalog.vue') },
      { path: 'pdf-tools/:convert', name: 'detail', component: () => import('@/views/ToolDetail.vue') },
    ],
  },
  // ---- Admin ----
  {
    path: '/admin/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/admin/change-password',
    name: 'change-password',
    component: () => import('@/views/ChangePassword.vue'),
  },
  {
    path: '/admin',
    component: () => import('@/layouts/DashboardLayout.vue'),
    children: [
      { path: '', name: 'overview', component: () => import('@/views/Overview.vue') },
      { path: 'logs', name: 'logs', component: () => import('@/views/Logs.vue') },
      { path: 'account', name: 'account', component: () => import('@/views/Account.vue') },
      { path: 'settings', name: 'settings', component: () => import('@/views/Settings.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const isAdminRoute = to.path.startsWith('/admin');
  if (!isAdminRoute && window.COMPDF_CONFIG?.compdfToolsEnabled === false) {
    return { name: 'overview' };
  }
  if (!isAdminRoute) return true;

  const auth = useAuthStore();

  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  // First-login forced change: block all non-public routes until password is changed.
  if (
    auth.isAuthenticated &&
    auth.mustChangePassword &&
    to.name !== 'change-password' &&
    to.name !== 'login'
  ) {
    return { name: 'change-password' };
  }
  // Already authenticated users hitting /admin/login go to the dashboard.
  if (to.name === 'login' && auth.isAuthenticated && !auth.mustChangePassword) {
    return { name: 'overview' };
  }
  return true;
});
