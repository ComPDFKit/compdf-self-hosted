<script setup lang="ts">
import LangSwitch from '@/components/LangSwitch.vue';
const brandMark = '/logo.svg';
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <RouterLink to="/" class="brand">
        <img :src="brandMark" alt="" class="brand-mark" />
      </RouterLink>
      <span class="divider"></span>
    </div>
    <LangSwitch />
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
.warn { color: #d97706; font-size: 13px; }
.ok { color: #6b6375; font-size: 13px; }
svg {
  width: 20px;
  height: 20px;
}
@media (max-width: 720px) {
  .app-header {
    gap: 8px;
    padding: 0 12px;
  }
  .brand {
    padding: 0;
  }
}
</style>
