import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'catalog', component: () => import('@/views/ToolCatalog.vue') },
  { path: '/pdf-tools/:convert', name: 'detail', component: () => import('@/views/ToolDetail.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({ history: createWebHistory(), routes });
