<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { toolI18nKey } from '@/config/i18n-keys';
import type { ToolDef } from '@/config/convert-map';
const props = defineProps<{ tool: ToolDef }>();
const { t } = useI18n();
const icon = computed(() => {
  // vite-svg-loader returns a component for `?component` imports
  const mods = import.meta.glob('@/assets/icons/*.svg', { eager: true, query: '?component', import: 'default' });
  return (mods as Record<string, any>)[`/src/assets/icons/${props.tool.icon}.svg`];
});
</script>

<template>
  <RouterLink :to="`/pdf-tools/${tool.slug}`" class="tool-card">
    <component :is="icon" class="tool-card-icon" v-if="icon" />
    <span class="tool-card-title">{{ t(toolI18nKey(tool.slug)) }}</span>
  </RouterLink>
</template>

<style scoped>
.tool-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 20px;
  width: 240px;
  min-height: 88px;
  padding: 24px 16px;
  overflow: hidden;
  border: 1px solid #d1d5dc;
  border-radius: 6px;
  background: #f3f6ff;
  color: #0a0d1c;
  text-decoration: none;
  transition: border-color .2s, background .2s, transform .2s;
  cursor: pointer;
}
.tool-card:hover { border-color: #88a9fc; background: #fff; transform: translateY(-1px); }
.tool-card-icon { width: 40px; height: 40px; flex: 0 0 40px; }
.tool-card-title {
  flex: 1;
  min-width: 0;
  font-size: 16px;
  font-weight: 400;
  line-height: 24px;
  word-break: break-word;
}
@media (max-width: 575px) {
  .tool-card {
    width: 100%;
  }
}
</style>
