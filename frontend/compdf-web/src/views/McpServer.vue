<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { dashboardApi, type McpConfiguration, type McpServiceStatus } from '@/api/dashboard';
import { copyText } from '@/lib/clipboard';
import copyBlueIcon from '@/assets/icons/mcp/copy-blue.svg?no-inline';
import copyMutedIcon from '@/assets/icons/mcp/copy-muted.svg?no-inline';
import externalLinkIcon from '@/assets/icons/mcp/external-link.svg?no-inline';

type ClientId = 'claudeDesktop' | 'claudeCode' | 'codex' | 'vscode';
const { t } = useI18n();
const configuration = ref<McpConfiguration | null>(null);
const serviceStatus = ref<McpServiceStatus['status'] | null>(null);
const selectedClient = ref<ClientId>('codex');
const loading = ref(true);
const loadError = ref(false);
const copyError = ref(false);
const copied = ref<'url' | 'configuration' | null>(null);
const tabButtons = ref<HTMLButtonElement[]>([]);
let stopped = false;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const clients = computed(() => [
  { id: 'claudeDesktop' as const, label: t('mcp.client.claudeDesktop'), file: 'claude_desktop_config.json', format: 'JSON' },
  { id: 'claudeCode' as const, label: t('mcp.client.claudeCode'), file: '.mcp.json', format: 'JSON' },
  { id: 'codex' as const, label: t('mcp.client.codex'), file: '~/.codex/config.toml', format: 'TOML' },
  { id: 'vscode' as const, label: t('mcp.client.vscode'), file: '.vscode/mcp.json', format: 'JSON' },
]);
const activeClient = computed(() => clients.value.find((client) => client.id === selectedClient.value)!);
const configurationText = computed(() => {
  const value = configuration.value;
  if (!value) return '';
  if (selectedClient.value === 'codex') return value.clients.codexToml.trimEnd();
  return JSON.stringify(value.clients[selectedClient.value], null, 2);
});
const statusLabel = computed(() => {
  if (serviceStatus.value === 'running') return t('mcp.status.running');
  if (serviceStatus.value === 'not_enabled') return t('mcp.status.notEnabled');
  if (serviceStatus.value === 'error') return t('mcp.status.error');
  return t('mcp.status.checking');
});

async function checkStatus() {
  try {
    const result = await dashboardApi.mcpStatus();
    if (!stopped) serviceStatus.value = result.status;
  } catch {
    if (!stopped) serviceStatus.value = 'error';
  }
  if (!stopped) statusTimer = setTimeout(checkStatus, 30_000);
}

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    const result = await dashboardApi.mcpConfiguration();
    if (!stopped) {
      configuration.value = result;
      if (!result.enabled) serviceStatus.value = 'not_enabled';
    }
  } catch {
    if (!stopped) {
      loadError.value = true;
      serviceStatus.value = 'error';
    }
  } finally {
    if (!stopped) loading.value = false;
  }
}

async function copy(target: 'url' | 'configuration') {
  const value = target === 'url' ? configuration.value?.url : configurationText.value;
  if (!value) return;
  copyError.value = false;
  try {
    await copyText(value);
    if (stopped) return;
    copied.value = target;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = null), 2_000);
  } catch {
    if (!stopped) copyError.value = true;
  }
}

function selectClient(id: ClientId) {
  selectedClient.value = id;
  copied.value = null;
  copyError.value = false;
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % clients.value.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + clients.value.length) % clients.value.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = clients.value.length - 1;
  else return;
  event.preventDefault();
  selectClient(clients.value[next]!.id);
  tabButtons.value[next]?.focus();
}

onMounted(() => {
  void load();
  void checkStatus();
});
onUnmounted(() => {
  stopped = true;
  clearTimeout(statusTimer);
  clearTimeout(copyTimer);
});
</script>

<template>
  <div class="mcp-page">
    <section class="mcp-service-card" :aria-label="t('mcp.title')">
      <div class="mcp-service-heading">
        <h1>{{ t('mcp.title') }}</h1>
        <span class="mcp-status" :class="`mcp-status--${serviceStatus || 'checking'}`" role="status" aria-live="polite">
          <span class="sr-only">{{ t('mcp.serviceStatus') }}: </span>
          <span class="mcp-status-dot" aria-hidden="true"></span>
          {{ statusLabel }}
        </span>
      </div>
      <div class="mcp-url-field">
        <label for="mcp-url">{{ t('mcp.url') }}</label>
        <div class="mcp-url-box">
          <input id="mcp-url" :value="configuration?.url || ''" readonly
            :placeholder="loading ? t('common.loading') : '-'" />
          <button type="button" class="mcp-copy mcp-copy--blue" :disabled="!configuration?.url" @click="copy('url')">
            <img :src="copyBlueIcon" width="14" height="14" alt="" />
            {{ copied === 'url' ? t('common.copied') : t('mcp.copy') }}
          </button>
        </div>
      </div>
    </section>

    <section class="mcp-integration-card" :aria-label="t('mcp.integration')">
      <h2>{{ t('mcp.integration') }}</h2>
      <div class="mcp-tabs" role="tablist" :aria-label="t('mcp.integration')">
        <button v-for="(client, index) in clients" :id="`mcp-tab-${client.id}`" :key="client.id" ref="tabButtons"
          type="button" role="tab" :class="{ 'is-active': selectedClient === client.id }"
          :aria-selected="selectedClient === client.id" :aria-controls="`mcp-panel-${client.id}`"
          :tabindex="selectedClient === client.id ? 0 : -1" @click="selectClient(client.id)"
          @keydown="onTabKeydown($event, index)">
          {{ client.label }}
        </button>
      </div>

      <div v-if="loading" class="mcp-loading" role="status">{{ t('common.loading') }}</div>
      <div v-else-if="loadError" class="mcp-error" role="alert">
        <p>{{ t('mcp.loadError') }}</p>
        <button type="button" @click="load">{{ t('mcp.retry') }}</button>
      </div>
      <div v-else :id="`mcp-panel-${selectedClient}`" class="mcp-panel" role="tabpanel"
        :aria-labelledby="`mcp-tab-${selectedClient}`">
        <div class="mcp-file-label">
          <span>{{ t('mcp.configurationFile') }}</span>
          <span class="mcp-file-tag">{{ activeClient.file }}</span>
        </div>
        <div class="mcp-code">
          <div class="mcp-code-heading">
            <span>{{ activeClient.format }}</span>
            <button type="button" class="mcp-copy mcp-copy--muted" :disabled="!configurationText"
              @click="copy('configuration')">
              <img :src="copyMutedIcon" width="14" height="14" alt="" />
              {{ copied === 'configuration' ? t('common.copied') : t('mcp.copy') }}
            </button>
          </div>
          <pre tabindex="0" :aria-label="t('mcp.configurationFile')"><code>{{ configurationText }}</code></pre>
        </div>
        <p class="mcp-verification">{{ t('mcp.verify', { client: activeClient.label }) }}</p>
      </div>

      <p v-if="copyError" class="mcp-copy-error" role="alert">{{ t('mcp.copyFailed') }}</p>
      <div class="mcp-key-notice">
        <p>{{ t('mcp.apiKeyNote') }}</p>
        <RouterLink :to="{ name: 'api-keys' }" class="mcp-key-link">
          {{ t('mcp.viewApiKey') }}
          <img :src="externalLinkIcon" width="16" height="16" alt="" />
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mcp-page {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  color: #0c131f;
}

.mcp-service-card,
.mcp-integration-card {
  min-width: 0;
  padding: 16px;
  border-radius: 6px;
  background: white;
}

.mcp-service-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mcp-service-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mcp-service-heading h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
}

.mcp-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  line-height: 22px;
}

.mcp-status-dot {
  flex: 0 0 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.mcp-status--running {
  color: #67d1a0;
}

.mcp-status--not_enabled,
.mcp-status--checking {
  color: #0c131f99;
}

.mcp-status--error {
  color: #d44040;
}

.mcp-url-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mcp-url-field label {
  font-size: 12px;
  line-height: 20px;
}

.mcp-url-box {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
  padding: 3px 4px;
  border: 1px solid #b0c5fd;
  border-radius: 3px;
  background: #f5f7ff;
}

.mcp-url-box input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: #0c131f;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-overflow: ellipsis;
}

.mcp-copy {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 2px 8px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  font-size: 12px;
  line-height: 20px;
}

.mcp-copy:disabled {
  cursor: default;
  opacity: 0.45;
}

.mcp-copy img {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
}

.mcp-copy--blue {
  color: #396ffa;
}

.mcp-copy--muted {
  color: #ffffff8c;
}

.mcp-integration-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mcp-integration-card h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
}

.mcp-tabs {
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid #e7e8e8;
}

.mcp-tabs button {
  flex-shrink: 0;
  padding: 13px 16px 10px;
  border: 0;
  border-bottom: 3px solid transparent;
  background: white;
  color: #0c131f99;
  font-size: 14px;
  line-height: 22px;
  white-space: nowrap;
}

.mcp-tabs button.is-active {
  border-bottom-color: #396ffa;
  color: #396ffa;
}

.mcp-panel {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
}

.mcp-file-label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 20px;
}

.mcp-file-tag {
  padding: 2px 8px;
  border-radius: 3px;
  background: #e7e8e8;
  overflow-wrap: anywhere;
}

.mcp-code {
  min-width: 0;
  overflow: hidden;
  border-radius: 6px;
  background: #15181d;
  color: white;
}

.mcp-code-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 24px;
  background: #20232b;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
}

.mcp-code pre {
  min-width: 0;
  margin: 0;
  overflow-x: auto;
  padding: 16px 24px;
  font-size: 12px;
  font-weight: 400;
  line-height: 20px;
  tab-size: 2;
}

.mcp-verification {
  margin: 0;
  padding-left: 18px;
  color: #0c131f66;
  font-size: 12px;
  line-height: 20px;
}

.mcp-verification::before {
  content: '•';
  display: inline-block;
  width: 12px;
  margin-left: -12px;
}

.mcp-key-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 6px;
  background: #e3ebff;
}

.mcp-key-notice p {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.mcp-key-link {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 5px 16px;
  border-radius: 3px;
  background: #396ffa;
  color: white;
  font-size: 14px;
  line-height: 22px;
  text-decoration: none;
}

.mcp-key-link img {
  width: 16px;
  height: 16px;
}

.mcp-loading {
  padding: 24px;
  color: #0c131f99;
  font-size: 14px;
  text-align: center;
}

.mcp-error,
.mcp-copy-error {
  margin: 0;
  color: #d44040;
  font-size: 14px;
  line-height: 22px;
}

.mcp-error button {
  margin-top: 8px;
  color: #396ffa;
  text-decoration: underline;
}

.mcp-page button:focus-visible,
.mcp-page a:focus-visible,
.mcp-code pre:focus-visible {
  outline: 2px solid #396ffa;
  outline-offset: 3px;
}

@media (max-width: 1100px) {
  .mcp-page {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 600px) {
  .mcp-service-heading {
    flex-wrap: wrap;
  }

  .mcp-key-notice {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }

  .mcp-code-heading,
  .mcp-code pre {
    padding-left: 16px;
    padding-right: 16px;
  }
}
</style>
