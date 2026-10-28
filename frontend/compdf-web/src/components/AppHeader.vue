<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import LangSwitch from '@/components/LangSwitch.vue';
import { TOOL_SECTIONS } from '@/config/convert-map';
import { SECTION_KEYS, toolI18nKey } from '@/config/i18n-keys';
import { DEFAULT_LOGO_URL, useBrandStore } from '@/stores/brand';
import chevronIcon from '@/assets/icons/header/nav-chevron-down.svg?no-inline';

const { t } = useI18n();
const brand = useBrandStore();
const route = useRoute();
const header = ref<HTMLElement | null>(null);
const openSection = ref<number | null>(null);
const sections = TOOL_SECTIONS
  .map((section, index) => ({ ...section, index, titleKey: SECTION_KEYS[index] }))
  .filter((section) => section.tools.length > 0);
const toolIcons = import.meta.glob<string>('@/assets/icons/*.svg', {
  eager: true,
  // Let Vite emit asset URLs; this project's SVG loader handles ?url as a file path.
  query: '?no-inline',
  import: 'default',
});
const activeSlug = computed(() => route.params.convert);
const toolImages = import.meta.glob<string>('@/assets/icons/*.png', { eager: true, import: 'default' });

function iconUrl(icon: string) {
  return toolIcons[`/src/assets/icons/${icon}.svg`] ?? toolImages[`/src/assets/icons/${icon}.png`];
}

function closeMenu() {
  openSection.value = null;
}

function leaveSection() {
  // A touch-generated mouseleave must not close a menu opened by tapping.
  if (window.matchMedia('(hover: hover)').matches) closeMenu();
}

function leaveFocus(event: FocusEvent) {
  const group = event.currentTarget as HTMLElement;
  if (!group.contains(event.relatedTarget as Node | null)) closeMenu();
}

async function focusFirstTool(index: number) {
  openSection.value = index;
  await nextTick();
  header.value?.querySelector<HTMLAnchorElement>(`#header-tools-${index} a`)?.focus();
}

function handlePointerDown(event: PointerEvent) {
  const group = header.value?.querySelector('.nav-group.is-open');
  if (!group?.contains(event.target as Node)) closeMenu();
}

function handleEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || openSection.value === null) return;
  const trigger = header.value?.querySelector<HTMLButtonElement>(`#header-trigger-${openSection.value}`);
  const focusWasInside = header.value?.querySelector('.nav-group.is-open')?.contains(document.activeElement);
  closeMenu();
  if (focusWasInside) {
    event.preventDefault();
    trigger?.focus();
  }
}

watch(() => route.fullPath, closeMenu);
onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown);
  document.addEventListener('keydown', handleEscape);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown);
  document.removeEventListener('keydown', handleEscape);
});
</script>

<template>
  <header ref="header" class="app-header">
    <div class="header-left">
      <RouterLink to="/" class="brand">
        <img :src="brand.c.logoUrl ?? DEFAULT_LOGO_URL" alt="" class="brand-mark" />
        <span class="brand-name">{{ brand.c.siteName }}</span>
      </RouterLink>
    </div>
    <nav v-if="brand.c.compdfToolsEnabled" class="primary-nav" :aria-label="t('header.demo')">
      <div
        v-for="section in sections"
        :key="section.index"
        class="nav-group"
        :class="{ 'is-open': openSection === section.index }"
        @mouseenter="openSection = section.index"
        @mouseleave="leaveSection"
        @focusout="leaveFocus"
      >
        <button
          :id="`header-trigger-${section.index}`"
          type="button"
          class="nav-trigger"
          :class="{ 'is-active': section.tools.some((tool) => tool.slug === activeSlug) }"
          :aria-expanded="openSection === section.index"
          :aria-controls="`header-tools-${section.index}`"
          @click="openSection = section.index"
          @keydown.down.prevent="focusFirstTool(section.index)"
        >
          <span>{{ t(section.titleKey) }}</span>
          <span class="nav-chevron" aria-hidden="true">
            <img :src="chevronIcon" alt="" />
          </span>
        </button>
        <div v-show="openSection === section.index" class="nav-dropdown">
          <ul
            :id="`header-tools-${section.index}`"
            class="tool-menu"
            :aria-labelledby="`header-trigger-${section.index}`"
          >
            <li v-for="tool in section.tools" :key="tool.slug">
              <RouterLink
                :to="`/pdf-tools/${tool.slug}`"
                class="tool-link"
                :class="{ 'is-active': tool.slug === activeSlug }"
                :aria-current="tool.slug === activeSlug ? 'page' : undefined"
                @click="closeMenu"
              >
                <img :src="iconUrl(tool.icon)" alt="" class="tool-icon" />
                <span>{{ t(toolI18nKey(tool.slug)) }}</span>
              </RouterLink>
            </li>
          </ul>
        </div>
      </div>
    </nav>
    <div class="header-right">

      <RouterLink to="/admin" class="dashboard-link">
        {{ t('appHeader.dashboard') }}
      </RouterLink>
      <span class="divider" aria-hidden="true"></span>
      <div class="language-switch">
        <LangSwitch />
      </div>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 70px;
  padding: 15px 50px;
  background: #e5ecff;
  color: #0c131f;
}
.header-left {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.header-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 24px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #0c131f;
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.brand-mark {
  flex-shrink: 0;
  height: 30px;
  max-width: 134px;
  object-fit: contain;
}
.brand-name {
  color: var(--brand-color, #1668ff);
}
.primary-nav {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0 16px;
  min-width: 0;
}
.nav-group {
  position: relative;
}
.nav-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 40px;
  padding: 8px 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #5d6f88;
  font-size: 16px;
  font-weight: 400;
  line-height: 24px;
  white-space: nowrap;
  transition: color 0.15s ease;
}
.nav-trigger.is-active,
.nav-group.is-open .nav-trigger,
.nav-trigger:hover {
  color: var(--brand-color, #1668ff);
}
.nav-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  transition: transform 0.15s ease;
}
.nav-chevron img {
  width: 10px;
  height: 6px;
}
.nav-group.is-open .nav-chevron {
  transform: rotate(180deg);
}
.nav-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 1;
  padding-top: 20px;

}
.nav-group:last-child .nav-dropdown {
  right: 0;
  left: auto;
}
.tool-menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: min(540px, calc(100dvh - 110px));
  margin: 0;
  padding: 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid #d1d5dc;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 0 36px rgba(205, 211, 229, 0.12), 0 34px 72px rgba(233, 233, 233, 0.2);
  list-style: none;
}
.tool-link {
  display: flex;
  align-items: center;
  gap: 20px;
  min-height: 32px;
  padding: 4px 16px;
  border-radius: 6px;
  color: #0c131f;
  font-size: 14px;
  font-weight: 400;
  line-height: 20px;
  text-decoration: none;
}
.tool-link span {
  flex-shrink: 0;
  white-space: nowrap;
}
.tool-link:hover,
.tool-link:focus-visible,
.tool-link.is-active {
  background: #f3f6ff;
}
.tool-icon {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
}
.divider {
  width: 1px;
  height: 16px;
  background: #d1d5dc;
}
.docs-link,
.language-switch :deep(button[data-slot="dropdown-menu-trigger"]) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 8px;
  border: 1px solid #d1d5dc;
  border-radius: 8px;
  background: #f3f6ff;
  color: #5d6f88;
  text-decoration: none;
}
.docs-link:hover,
.language-switch :deep(button[data-slot="dropdown-menu-trigger"]:hover) {
  background: #fff;
  color: var(--brand-color, #1668ff);
}
.language-switch :deep(svg) {
  width: 24px;
  height: 24px;
}
.dashboard-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  padding: 8px 16px;
  border: 1px solid #d1d5dc;
  border-radius: 8px;
  background: #F3F6FF;
  color: #396FFA;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
  text-decoration: none;
  transition: background 0.15s ease;
  white-space: nowrap;
}
.dashboard-link:hover {
  background: #fff;
}
.nav-trigger:focus-visible,
.docs-link:focus-visible,
.dashboard-link:focus-visible,
.tool-link:focus-visible {
  outline: 2px solid var(--brand-color, #1668ff);
  outline-offset: 2px;
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
:global(html.dark) .nav-trigger {
  color: #b7bccb;
}
:global(html.dark) .nav-trigger.is-active,
:global(html.dark) .nav-group.is-open .nav-trigger {
  color: var(--brand-color, #1668ff);
}
:global(html.dark) .tool-menu {
  border-color: #3b4055;
  background: #24283b;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.25);
}
:global(html.dark) .tool-link {
  color: #e5ecff;
}
:global(html.dark) .tool-link:hover,
:global(html.dark) .tool-link:focus-visible,
:global(html.dark) .tool-link.is-active {
  background: #30364d;
}
:global(html.dark) .docs-link,
:global(html.dark) .dashboard-link,
:global(html.dark) .language-switch :deep(button[data-slot="dropdown-menu-trigger"]) {
  border-color: #3b4055;
  background: #24283b;
}
:global(html.dark) .docs-link,
:global(html.dark) .language-switch :deep(button[data-slot="dropdown-menu-trigger"]) {
  color: #b7bccb;
}
:global(html.dark) .language-switch :deep(svg) {
  filter: brightness(1.6);
}
@media (max-width: 1279px) {
  .app-header {
    flex-wrap: wrap;
    padding: 12px;
    gap: 8px 24px;
  }
  .primary-nav {
  }
}
</style>
