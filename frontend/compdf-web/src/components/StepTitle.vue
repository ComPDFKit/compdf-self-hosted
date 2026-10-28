<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { toolI18nKey } from '@/config/i18n-keys';
import { resolveTool } from '@/config/convert-map';
import { toolIcon } from '@/utils/tool-icons';

const props = withDefaults(
  defineProps<{
    /** Source file type — the 3-step indicator only renders for '', 'pdf', or 'img'. */
    fromType?: string;
    /** Upload panel file status: '' | 'await' | 'success' drives the step check-states. */
    fileStatus?: string;
    /** Catalog tool slug, resolved via toolI18nKey() for the title text. */
    toolSlug: string;
  }>(),
  { fromType: '', fileStatus: '' },
);

const { t } = useI18n();
const icon = computed(() => {
  const tool = resolveTool(props.toolSlug);
  if (!tool) return null;
  return toolIcon(tool.icon) ?? null;
});
</script>

<template>
  <div class="step-title">
    <h1 class="step-title-heading">
      <component :is="icon" v-if="icon" class="step-title-icon" />
      <span>{{ t(toolI18nKey(toolSlug)) }}</span>
    </h1>
  </div>
</template>

<style scoped>
.step-title {
  font-family: 'Encode Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  padding-top: 0;
}

.step-title-heading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-bottom: 24px;
  font-size: 30px;
  font-weight: 600;
  color: #0a0d1c;
  line-height: 40px;
  text-align: center;
}

.step-title-icon {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
}

.step-title-steps {
  display: flex;
  width: 100%;
  margin-bottom: 24px;
  justify-content: center;
}
.step-title-steps--await { justify-content: center; }
.step-title-steps--success { justify-content: flex-end; }

.step-title-step {
  margin-right: 12px;
  padding-right: 10px;
}
.step-title-step:last-child { margin-right: 0; }

.step-title-label {
  margin: 0;
  padding: 0 0 6px 6px;
  font-size: 14px;
  font-weight: 500;
  color: #94969d;
}
.step-title-label--active { color: #52555f; }

.step-title-num {
  margin-right: 8px;
  font-weight: 600;
}

.step-title-bar {
  display: flex;
  align-items: center;
}

.step-title-check {
  margin-right: 8px;
  flex: none;
}

.step-title-placeholder {
  display: block;
  width: 26px;
  height: 26px;
  margin: 3px 11px 3px 3px;
  border: 2px solid #cddbff;
  border-radius: 50%;
  flex: none;
}

.step-title-dashed {
  display: block;
  width: 200px;
  border-bottom: 2px dashed #cddbff;
  flex: none;
}

/* The 3-step indicator is a wide horizontal element; hide it on narrow screens. */
@media (max-width: 929px) {
  .step-title-steps { display: none; }
}
</style>
