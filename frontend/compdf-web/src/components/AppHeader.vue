<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import LangSwitch from '@/components/LangSwitch.vue';
import { useBrandStore } from '@/stores/brand';

const { t } = useI18n();
const brand = useBrandStore();
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <RouterLink to="/" class="brand">
        <img :src="brand.c.logoUrl ?? '/logo.svg'" alt="" class="brand-mark" />
        <span class="brand-name">{{ brand.c.siteName }}</span>
      </RouterLink>
      <span class="divider"></span>
      <a
        v-if="brand.c.docUrl"
        class="docs-link"
        :href="brand.c.docUrl"
        target="_blank"
        rel="noopener"
      >
        {{ t('appHeader.documentation') }}
      </a>
    </div>
    <div class="header-right">
      <RouterLink to="/admin" class="dashboard-link">
        {{ t('appHeader.dashboard') }}
      </RouterLink>
      <LangSwitch />
    </div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 72px;
  padding: 0 20px;
  background: #e5ecff;
  color: #0a0d1c;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 100%;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  color: #0a0d1c;
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
}
.brand-mark {
  height: 30px;
}
.brand-name {
  color: var(--brand-color, #1668ff);
}
.divider {
  width: 1px;
  height: 24px;
  background: rgba(10, 13, 28, 0.12);
}
.docs-link {
  color: #52555f;
  font-size: 14px;
  text-decoration: none;
}
.docs-link:hover {
  color: var(--brand-color, #1668ff);
}
.dashboard-link {
  display: inline-flex;
  align-items: center;
  padding: 7px 14px;
  border-radius: 8px;
  background: var(--brand-color, #1668ff);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  transition: opacity 0.15s ease;
  white-space: nowrap;
}
.dashboard-link:hover {
  opacity: 0.92;
}
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #52555f;
}
.theme-toggle:hover {
  background: rgba(10, 13, 28, 0.06);
}
.theme-toggle .icon {
  width: 20px;
  height: 20px;
}
:global(html.dark) .app-header {
  background: #1a1d2e;
  color: #e5ecff;
}
:global(html.dark) .brand {
  color: #e5ecff;
}
:global(html.dark) .divider {
  background: rgba(229, 236, 255, 0.16);
}
:global(html.dark) .docs-link {
  color: #b7bccb;
}
:global(html.dark) .theme-toggle {
  color: #b7bccb;
}
:global(html.dark) .theme-toggle:hover {
  background: rgba(229, 236, 255, 0.08);
}
@media (max-width: 720px) {
  .app-header {
    gap: 8px;
    padding: 0 12px;
  }
  .brand {
    padding: 0;
  }
  .brand-name {
    display: none;
  }
  .docs-link {
    display: none;
  }
}
</style>
