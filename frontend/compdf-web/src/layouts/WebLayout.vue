<script setup lang="ts">
/**
 * WebLayout — chrome for the public ComPDF Web demo routes (`/`, `/pdf-tools/*`).
 * Wraps the web AppHeader (brand + docs link + lang/theme switch) around the
 * routed tool view. Admin routes use DashboardLayout instead.
 */
import { RouterView } from 'vue-router';
import AppHeader from '@/components/AppHeader.vue';
</script>

<template>
  <div class="page">
    <AppHeader />
    <RouterView />
  </div>
</template>

<style scoped>
.page {
  min-width: 1280px;
}
</style>
