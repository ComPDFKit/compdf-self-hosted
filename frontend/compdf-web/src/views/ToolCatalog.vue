<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Cross2Icon } from '@radix-icons/vue';
import { TOOL_SECTIONS } from '@/config/convert-map';
import { SECTION_KEYS } from '@/config/i18n-keys';
import ToolCard from '@/components/ToolCard.vue';
import { useBrandStore } from '@/stores/brand';
import bannerImage from '@/assets/banner.png';
const { t } = useI18n();
const brand = useBrandStore();
const isDemoBannerVisible = ref(true);
</script>

<template>
  <main class="catalog">
    <div class="catalog-panel">
      <section v-for="(section, idx) in TOOL_SECTIONS" :key="idx" class="section">
        <h2>
          <span>{{ t(SECTION_KEYS[idx]) }}</span>
        </h2>
        <div class="grid">
          <ToolCard v-for="tool in section.tools" :key="tool.slug" :tool="tool" />
        </div>
      </section>
    </div>
  </main>
  <aside
    v-if="isDemoBannerVisible && !brand.c.isFormalLicense"
    class="demo-banner demo-banner--fixed"
    data-test="demo-banner"
    :style="{ backgroundImage: `url(${bannerImage})` }"
  >
    <div class="demo-banner-content">
      <p>{{ brand.c.upgradeBannerText ?? t('demoBanner.title') }}</p>
      <a :href="brand.c.contactUrl ?? 'https://www.compdf.com/contact-sales'" target="_blank" rel="noopener">{{ t('demoBanner.upgrade') }}</a>
    </div>
    <button
      class="demo-banner-close"
      data-test="demo-banner-close"
      type="button"
      :aria-label="t('demoBanner.closeLabel')"
      @click="isDemoBannerVisible = false"
    >
      <Cross2Icon aria-hidden="true" />
    </button>
  </aside>
</template>

<style scoped>
.catalog {
  min-height: calc(100vh - 72px);
  padding: 0 16px 96px;
  background: #e5ecff;
}
.catalog-panel {
  display: flex;
  flex-direction: column;
  gap: 32px;
  width: 100%;
  margin: 0 auto;
  padding: 34px;
  border-radius: 16px;
  background: #fbfcff;
}
.section h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 30px;
  color: #0c131f;
  font-size: 20px;
  font-weight: 600;
  line-height: 32px;
}
.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.demo-banner {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 64px;
  padding: 8px 64px;
  overflow: hidden;
  background-color: var(--brand-color, #1668ff);
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
  color: #0a0d1c;
  box-shadow: 0 -8px 32px rgba(15, 23, 42, 0.08);
  z-index: 30;
}
.demo-banner--fixed {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
}
.demo-banner-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20px;
  width: 100%;
}
.demo-banner-close {
  position: absolute;
  top: 8px;
  right: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  transition: background 0.2s ease, transform 0.2s ease;
}
.demo-banner-close:hover {
  background: rgba(255, 255, 255, 0.32);
}
.demo-banner-close:active {
  transform: scale(0.96);
}
.demo-banner-close svg {
  width: 16px;
  height: 16px;
}
.demo-banner p {
  margin: 0;
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.demo-banner a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 111px;
  height: 32px;
  padding: 0 16px;
  border-radius: 8px;
  background: #fff;
  color: #1c57ff;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  box-shadow: 0 4px 16px rgba(9, 38, 110, 0.16);
}
@media (max-width: 575px) {
  .catalog {
    padding: 0 12px 120px;
  }
  .catalog-panel {
    padding: 24px 16px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr;
  }
  .demo-banner {
    align-items: stretch;
    min-height: 96px;
    padding: 16px 48px 16px 16px;
  }
  .demo-banner-content {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
  .demo-banner p {
    font-size: 14px;
    line-height: 20px;
  }
  .demo-banner a {
    min-width: 96px;
    height: 30px;
    padding: 0 12px;
    font-size: 13px;
  }
}
</style>
