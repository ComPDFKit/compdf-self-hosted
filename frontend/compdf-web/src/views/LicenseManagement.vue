<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Download } from 'lucide-vue-next';
import { dashboardApi, type LicenseDisplay } from '@/api/dashboard';
import { downloadBlob } from '@/api/client';
import LicenseUpdate from '@/components/LicenseUpdate.vue';
import warningIcon from '@/assets/icons/license/warning.svg?no-inline';
import expiredIcon from '@/assets/icons/license/expired.svg?no-inline';
import closeIcon from '@/assets/icons/license/close.svg?no-inline';
import featureSupportedIcon from '@/assets/icons/license/feature-supported.svg?no-inline';
import upgradeArrowIcon from '@/assets/icons/license/upgrade-arrow.svg?no-inline';

const CONTACT_URL = 'https://www.compdf.com/contact-sales?utm_source=sdk_product&utm_medium=compdf_self_hosted&utm_campaign=license_management';
const { t } = useI18n();
const license = ref<LicenseDisplay | null>(null);
const loading = ref(true);
const dismissed = ref(false);

onMounted(async () => {
  try {
    license.value = await dashboardApi.licenseDisplay();
  } finally {
    loading.value = false;
  }
});

const status = computed(() => license.value?.status ?? 'inactive');
const hasLicense = computed(() => !!license.value?.present);
const expirationDate = computed(() => {
  const endTime = license.value?.endTime;
  if (!endTime) return null;
  const timestamp = Date.parse(`${endTime}T00:00:00Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
});
const daysUntilExpiry = computed(() => {
  if (!expirationDate.value) return null;
  return Math.ceil((expirationDate.value.getTime() - Date.now()) / 86_400_000);
});
const daysExpired = computed(() => {
  if (!expirationDate.value || expirationDate.value.getTime() >= Date.now()) return 0;
  return Math.max(1, Math.floor((Date.now() - expirationDate.value.getTime()) / 86_400_000));
});
const formattedValidity = computed(() => {
  if (!hasLicense.value) return '-';
  const start = license.value?.startTime || '-';
  const end = license.value?.endTime || '-';
  if (start === '-' && end === '-') return '-';
  return `${start} - ${end}`;
});
const licenseIdentifier = computed(() => license.value?.fileName || 'license.xml');
const alert = computed(() => {
  if (!hasLicense.value) return null;
  if (status.value === 'expiring') return { kind: 'warning', text: t('license.alert.expiring', { days: daysUntilExpiry.value ?? 0 }), action: t('license.contactSales') };
  if (status.value === 'expired') {
    if (daysExpired.value > 0) return { kind: 'error', text: t('license.alert.expiredDays', { days: daysExpired.value }), action: t('license.renewNow') };
    return { kind: 'error', text: t('license.alert.expired'), action: t('license.renewNow') };
  }
  return null;
});
const statusMeta = computed(() => ({
  inactive: { label: t('license.status.inactive'), class: 'border-[#d66] bg-[#fbecec] text-[#d44040]', dot: 'bg-[#d44040]' },
  valid: { label: t('license.status.active'), class: 'border-[#67d1a0] bg-[#ecf9f3] text-[#17845a]', dot: 'bg-[#67d1a0]' },
  expiring: { label: t('license.status.expiring'), class: 'border-[#f2b66d] bg-[#fce7ce] text-[#9b5b15]', dot: 'bg-[#e99c3e]' },
  expired: { label: t('license.status.expired'), class: 'border-[#d66] bg-[#fbecec] text-[#d44040]', dot: 'bg-[#d44040]' },
}[status.value]));
const features = [
  { key: 'pdfEditing', free: true },
  { key: 'pdfConversion', free: true },
  { key: 'webUi', free: true },
  { key: 'dashboard', free: true },
  { key: 'watermarkFree', free: false },
  { key: 'unlimitedPages', free: false },
  { key: 'customConcurrency', free: false },
  { key: 'commercialLicense', free: false },
  { key: 'technicalSupport', free: false },
] as const;

async function downloadLicense() {
  if (!hasLicense.value) return;
  const response = await dashboardApi.downloadLicense();
  downloadBlob(response, licenseIdentifier.value);
}

</script>

<template>
  <div class="flex w-full flex-col gap-4 font-sans text-[#0c131f]">
    <div class="flex items-center justify-between">
      <h1 class="text-[18px] font-semibold leading-[26px]">{{ t('license.title') }}</h1>
    </div>

    <div
      v-if="alert && (alert.kind === 'error' || !dismissed)"
      class="license-alert"
      :class="`license-alert--${alert.kind}`"
      :role="alert.kind === 'error' ? 'alert' : 'status'"
    >
      <img :src="alert.kind === 'warning' ? warningIcon : expiredIcon" class="license-alert__icon" width="20" height="20" alt="" />
      <div class="license-alert__body">
        <p class="license-alert__message">{{ alert.text }}</p>
        <a :href="CONTACT_URL" target="_blank" rel="noopener noreferrer" class="license-alert__action">{{ alert.action }}</a>
      </div>
      <button
        v-if="alert.kind === 'warning'"
        type="button"
        class="license-alert__close"
        :aria-label="t('common.close')"
        @click="dismissed = true"
      >
        <img :src="closeIcon" width="16" height="16" alt="" />
      </button>
    </div>

    <div v-if="loading" class="rounded-md bg-white p-10 text-center text-sm text-slate-500">{{ t('common.loading') }}</div>
    <template v-else>
      <div class="grid gap-4 xl:grid-cols-[1.047fr_1fr] xl:items-start">
        <div class="min-w-0 rounded-md bg-white p-4 shadow-sm">
          <div class="py-4">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <h2 class="text-base font-semibold leading-6">{{ t('license.file') }}</h2>
              <span v-if="hasLicense" :class="['inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1 text-sm', statusMeta.class]"><span :class="['h-1.5 w-1.5 rounded-full', statusMeta.dot]" />{{ statusMeta.label }}</span>
            </div>
            <LicenseUpdate compact class="mt-3">
              <template #actions>
                <button v-if="hasLicense" type="button" class="inline-flex h-8 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded border border-[#396ffa] bg-white px-4 text-sm text-[#396ffa]" :aria-label="t('license.download')" @click="downloadLicense"><Download :size="15" />{{ t('license.download') }}</button>
              </template>
            </LicenseUpdate>
            <div class="mt-4 border-t border-[#e7e8e8] pt-4">
              <div class="grid grid-cols-1 gap-3">
                <div class="flex flex-col gap-1"><p class="text-xs leading-5 text-black/40">{{ t('license.validity') }}</p><p class="text-sm leading-[22px]">{{ formattedValidity }}</p></div>
              </div>
            </div>
          </div>
        </div>

        <div class="license-comparison">
          <div class="license-comparison__scroll">
            <div class="license-comparison__content">
              <table class="license-comparison__table" :aria-label="t('license.features')">
                <thead>
                  <tr>
                    <th scope="col">{{ t('license.features') }}</th>
                    <th scope="col">{{ t('license.freeVersion') }}</th>
                    <th scope="col">{{ t('license.enterpriseVersion') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="feature in features" :key="feature.key">
                    <td>{{ t(`license.feature.${feature.key}`) }}</td>
                    <td>
                      <img v-if="feature.free" :src="featureSupportedIcon" class="license-comparison__icon" width="16" height="16" :alt="t('common.yes')" />
                      <span v-else class="license-comparison__unavailable" role="img" :aria-label="t('common.no')"></span>
                    </td>
                    <td>
                      <img :src="featureSupportedIcon" class="license-comparison__icon" width="16" height="16" :alt="t('common.yes')" />
                    </td>
                  </tr>
                </tbody>
              </table>
              <div class="license-comparison__footer">
                <p>{{ t('license.adjustPlan') }}</p>
                <a :href="CONTACT_URL" target="_blank" rel="noopener noreferrer" class="license-comparison__upgrade">
                  {{ t('license.upgrade') }}
                  <img :src="upgradeArrowIcon" width="16" height="16" alt="" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.license-comparison {
  min-width: 0;
  overflow: hidden;
  border: 1px solid #dcdde1;
  border-radius: 6px;
  background: white;
}
.license-comparison__scroll { overflow-x: auto; }
.license-comparison__content { min-width: 600px; }
.license-comparison__table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  color: #0c131f;
  font-size: 14px;
  line-height: 22px;
}
.license-comparison__table th,
.license-comparison__table td {
  width: 33.333333%;
  height: 40px;
  padding: 0;
  vertical-align: middle;
  text-align: center;
}
.license-comparison__table th {
  background: #15181d;
  color: white;
  font-weight: 500;
}
.license-comparison__table th:first-child,
.license-comparison__table td:first-child {
  padding: 0 24px;
  text-align: left;
}
.license-comparison__table tbody tr { background: white; }
.license-comparison__table tbody tr:nth-child(even) {
  background: #f5f7ff;
  border-bottom: 1px solid #d7e2fe;
}
.license-comparison__icon {
  display: block;
  width: 16px;
  height: 16px;
  margin: 0 auto;
}
.license-comparison__unavailable {
  position: relative;
  display: block;
  width: 16px;
  height: 16px;
  margin: 0 auto;
  border-radius: 50%;
  background: #0c131f42;
}
.license-comparison__unavailable::after {
  position: absolute;
  top: 7.2px;
  left: 4px;
  width: 8px;
  height: 1.6px;
  background: white;
  content: '';
}
.license-comparison__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 56px;
  padding: 12px 24px;
  background: #e3ebff;
  font-size: 14px;
  line-height: 22px;
}
.license-comparison__footer p { min-width: 0; margin: 0; color: #396ffa; }
.license-comparison__upgrade {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 5px 16px;
  border-radius: 3px;
  background: #396ffa;
  color: white;
  line-height: 22px;
  text-decoration: none;
  white-space: nowrap;
}
.license-comparison__upgrade img { width: 16px; height: 16px; }
.license-comparison__upgrade:focus-visible { outline: 2px solid #396ffa; outline-offset: 3px; }
.license-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 54px;
  padding: 16px 24px;
  border-radius: 6px;
  color: #0c131f;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
}
.license-alert--warning { background: #fce7ce; }
.license-alert--error { background: #f6d9d9; }
.license-alert__icon {
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
}
.license-alert__body {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.license-alert__message {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.license-alert__action {
  flex-shrink: 0;
  max-width: 100%;
  color: #396ffa;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.license-alert__action:hover { text-decoration: underline; }
.license-alert--error .license-alert__action { margin-left: auto; }
.license-alert__close {
  display: inline-flex;
  flex: 0 0 16px;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
}
.license-alert__close img { width: 16px; height: 16px; }
.license-alert__action:focus-visible,
.license-alert__close:focus-visible {
  outline: 2px solid #396ffa;
  outline-offset: 3px;
}
@media (max-width: 600px) {
  .license-alert { align-items: flex-start; }
  .license-alert__icon { margin-top: 1px; }
  .license-alert__close { margin-top: 3px; }
}
</style>
