<script setup lang="ts">
/**
 * ToolDetail — the per-tool conversion page shell.
 *
 * fromType/toType are derived from the resolved tool via resolveConversionTypes,
 * so ParamForm feature flags and buildRequest produce the correct payloads for
 * all catalog tools.
 *
 * Route param is `convert` (NOT slug) — see router/index.ts. The catalog links
 * to /pdf-tools/${tool.slug}, so route.params.convert holds the slug.
 */
import { computed, ref } from 'vue';
import { ChevronLeftIcon } from '@radix-icons/vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { resolveTool, resolveConversionTypes } from '@/config/convert-map';
import { toolI18nKey } from '@/config/i18n-keys';
import StepTitle from '@/components/StepTitle.vue';
import UploadPanel from '@/components/UploadPanel.vue';

const route = useRoute();
const { t } = useI18n();
const slug = computed(() => route.params.convert as string);
const tool = computed(() => resolveTool(slug.value));
const fromType = computed(() => (tool.value ? resolveConversionTypes(tool.value).fromType : ''));
const toType = computed(() => (tool.value ? resolveConversionTypes(tool.value).toType : ''));
const toolTitle = computed(() => (tool.value ? t(toolI18nKey(tool.value.slug)) : ''));
const fileStatus = ref<string>('');
</script>

<template>
  <main class="detail-page" v-if="tool">
    <section class="detail-panel">
      <button class="detail-breadcrumb" type="button" @click="$router.push('/pdf-tools')">
        <ChevronLeftIcon class="detail-back-icon" />
        <span>{{ t('toolDetail.back') }}</span>
        <span class="detail-separator">/</span>
        <span class="detail-current">{{ toolTitle }}</span>
      </button>
      <div class="detail-content">
        <StepTitle :tool-slug="slug" :from-type="fromType" :file-status="fileStatus" />
        <UploadPanel
          :from-type="fromType"
          :to-type="toType"
          :mode="tool.multiple ? 'multiple' : 'single'"
          :accept="tool.accept"
          :tool-slug="slug"
          :endpoint="tool.endpoint"
          @update-status="(s) => (fileStatus = s)"
        />
      </div>
    </section>
  </main>
  <main v-else class="detail-page not-found">
    <section class="detail-panel not-found-panel">
      <p>{{ t('toolDetail.unknownTool') }}</p>
      <button type="button" @click="$router.push('/pdf-tools')">{{ t('toolDetail.back') }}</button>
    </section>
  </main>
</template>

<style scoped>
.detail-page {
  min-height: calc(100vh - 72px);
  padding: 0 16px 16px;
  background: #e5ecff;
}
.detail-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: calc(100vh - 88px);
  width: 100%;
  margin: 0 auto;
  padding: 22px 35px 44px;
  border-radius: 16px;
  background: #fbfcff;
}
.detail-content {
  width: min(100%, 980px);
  padding-top: 72px;
}
.detail-breadcrumb {
  position: absolute;
  top: 22px;
  left: 28px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #0a0d1c;
  font: inherit;
  font-size: 16px;
  line-height: 24px;
  cursor: pointer;
}
.detail-back-icon {
  width: 14px;
  height: 14px;
  color: #8ba8ca;
}
.detail-separator {
  color: #6b7280;
}
.detail-current {
  color: #0a0d1c;
}
.not-found-panel {
  align-items: center;
  text-align: center;
}
.not-found p {
  margin: 0 0 12px;
  color: #6b6375;
}
.not-found button {
  border: 0;
  background: transparent;
  color: #396ffa;
  text-decoration: none;
}
.not-found button:hover {
  text-decoration: underline;
}
@media (max-width: 929px) {
  .detail-page {
    padding: 0 12px 12px;
  }
  .detail-panel {
    padding: 20px;
  }
  .detail-content {
    padding-top: 48px;
  }
  .detail-breadcrumb {
    left: 20px;
  }
}
</style>
