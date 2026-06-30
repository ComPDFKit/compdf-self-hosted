<script setup lang="ts">
import { useI18n } from 'vue-i18n';

defineProps<{
  ready: boolean;
  loading: boolean;
  error?: string;
  truncated?: boolean;
  processed?: number;
  total?: number;
  onDownload: () => void;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="result">
    <p v-if="loading" class="state">{{ t('resultDownload.loading') }}</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <template v-else-if="ready">
      <button class="btn" @click="onDownload">{{ t('resultDownload.download') }}</button>
      <p v-if="truncated" class="warn">{{ t('resultDownload.truncated', { processed, total }) }}</p>
    </template>
  </div>
</template>

<style scoped>
.result { margin-top: 16px; }
.state, .error, .warn { margin: 8px 0; font-size: 14px; }
.error { color: #d92d20; }
.warn { color: #d97706; }
.btn { padding: 8px 20px; border: 0; border-radius: 6px; background: #396ffa; color: #fff; font-size: 14px; }
.btn:hover { background: #2b59e0; }
</style>
