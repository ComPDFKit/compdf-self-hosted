<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  Eye, EyeOff, KeyRound, CheckCircle2, AlertCircle, AlertTriangle, Info, Camera,
} from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { dashboardApi, type LoginRecord } from '@/api/dashboard';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';

type ToastType = 'success' | 'error' | 'warning' | 'info';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();

const editingUsername = ref(auth.username || 'Admin');
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const showCurrent = ref(false);
const showNew = ref(false);
const showConfirm = ref(false);
const forgotPasswordOpen = ref(false);
const toast = ref<{ message: string; type: ToastType } | null>(null);

const usernameError = ref('');
const currentError = ref('');
const newError = ref('');
const confirmError = ref('');

const loginRecords = ref<LoginRecord[]>([]);
onMounted(async () => {
  try {
    const res = await dashboardApi.loginRecords(1, 10);
    loginRecords.value = res.items;
  } catch {
    // best-effort
  }
});

function displayToast(message: string, type: ToastType = 'success') {
  toast.value = { message, type };
  setTimeout(() => (toast.value = null), 3000);
}

const sameAsOld = computed(() => newPassword.value.length > 0 && currentPassword.value.length > 0 && newPassword.value === currentPassword.value);

async function saveUsername() {
  usernameError.value = '';
  if (!editingUsername.value.trim()) {
    usernameError.value = t('account.usernameEmpty');
    return;
  }
  try {
    await dashboardApi.updateAccount(editingUsername.value.trim());
    displayToast(t('account.usernameUpdated'));
  } catch {
    usernameError.value = t('account.usernameUpdateFailed');
  }
}

function getStrength(pwd: string) {
  if (!pwd) return { label: t('account.strengthNone'), style: 'text-stone-400' };
  if (pwd.length < 8) return { label: t('account.strengthWeak'), style: 'text-red-500 font-bold' };
  let score = 0;
  if (/[a-zA-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  if (pwd.length >= 12) score++;
  if (score <= 1) return { label: t('account.strengthWeak'), style: 'text-red-500 font-bold' };
  if (score === 2) return { label: t('account.strengthMedium'), style: 'text-amber-500 font-bold' };
  return { label: t('account.strengthStrong'), style: 'text-emerald-600 font-bold' };
}
const strength = computed(() => getStrength(newPassword.value));

async function changePassword() {
  currentError.value = '';
  newError.value = '';
  confirmError.value = '';
  if (!currentPassword.value) { currentError.value = t('account.requireCurrentPassword'); return; }
  // PRD: 8-64 chars, must contain letters AND numbers.
  if (newPassword.value.length < 8 || newPassword.value.length > 64) {
    newError.value = t('account.passwordLength'); return;
  }
  if (!/[A-Za-z]/.test(newPassword.value) || !/\d/.test(newPassword.value)) {
    newError.value = t('account.passwordWeak'); return;
  }
  if (sameAsOld.value) { newError.value = t('changePassword.sameAsOld'); return; }
  if (newPassword.value !== confirmPassword.value) { confirmError.value = t('changePassword.mismatch'); return; }
  try {
    await auth.changePassword(currentPassword.value, newPassword.value);
    displayToast(t('account.passwordChanged'), 'success');
    // PRD: 提示密码已修改 → 跳转登录页重新登录.
    setTimeout(() => {
      auth.logout();
      router.push({ name: 'login' });
    }, 1200);
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { message?: string } }; message?: string };
    const status = e?.response?.status;
    const msg = e?.response?.data?.message ?? e?.message ?? '';
    if ((status === 400 || status === 401) && /current password incorrect/i.test(msg)) {
      currentError.value = t('changePassword.incorrectOld');
    } else if (status === 400 && /new password must differ/i.test(msg)) {
      newError.value = t('changePassword.sameAsOld');
    } else {
      displayToast(t('account.changeFailed'), 'error');
    }
  }
}

function logout() {
  auth.logout();
  router.push({ name: 'login' });
}

const toastStyles: Record<ToastType, { box: string; icon: string; iconComp: typeof CheckCircle2 }> = {
  success: { box: 'bg-emerald-50 border-emerald-100 text-emerald-800', icon: 'text-emerald-500', iconComp: CheckCircle2 },
  error: { box: 'bg-rose-50 border-rose-100 text-rose-800', icon: 'text-rose-500', iconComp: AlertCircle },
  warning: { box: 'bg-amber-50 border-amber-100 text-amber-800', icon: 'text-amber-500', iconComp: AlertTriangle },
  info: { box: 'bg-blue-50 border-blue-100 text-blue-800', icon: 'text-blue-500', iconComp: Info },
};
</script>

<template>
  <div class="space-y-6 max-w-7xl mx-auto">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      <!-- Profile card -->
      <div class="lg:col-span-1 space-y-6">
        <div class="bg-white border border-brand-outline-variant/30 rounded-3xl p-6 shadow-sm flex flex-col items-center">
          <div class="relative w-28 h-28 mx-auto mt-4">
            <div class="w-full h-full rounded-2xl bg-gradient-to-br from-slate-800 to-slate-950 flex items-center justify-center border border-slate-700/60 shadow-inner overflow-hidden select-none">
              <span class="text-3xl font-bold text-white">{{ (auth.username || 'A').charAt(0).toUpperCase() }}</span>
            </div>
            <button
              @click="displayToast(t('account.cameraUnsupported'), 'warning')"
              class="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-[#2563eb] hover:bg-[#1d4ed8] text-white flex items-center justify-center border-2 border-white shadow-md hover:scale-110 transition cursor-pointer"
            >
              <Camera :size="14" />
            </button>
          </div>
          <h3 class="font-sans text-lg font-bold text-stone-900 mt-5 tracking-tight select-none">{{ auth.username || 'Admin' }}</h3>
          <span class="text-[11px] font-medium text-stone-500 bg-slate-100 rounded-lg px-3 py-1 mt-1.5 font-sans select-none">{{ t('account.roleEnterpriseAdmin') }}</span>

          <div class="h-[1px] w-full bg-slate-100 my-6" />

          <form @submit.prevent="saveUsername" class="w-full space-y-1.5 text-left text-xs font-sans">
            <label class="text-xs text-stone-700 font-medium">{{ t('account.username') }}</label>
            <div class="flex gap-2 w-full">
              <input
                v-model="editingUsername"
                type="text"
                class="flex-1 border border-slate-200 hover:border-slate-300 focus:border-[#2563eb] transition rounded-lg px-3 py-2 text-stone-800 focus:outline-none bg-white text-xs"
                required
              />
              <button type="submit" class="bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-bold px-4 rounded-lg text-xs tracking-wide transition shadow-sm cursor-pointer">{{ t('common.save') }}</button>
            </div>
            <p v-if="usernameError" class="text-[10px] text-red-500 mt-1">{{ usernameError }}</p>
            <p v-else class="text-[10px] text-stone-400 font-sans mt-1">{{ t('account.usernameHint') }}</p>
          </form>

          <div class="h-[1px] w-full bg-slate-100 my-4" />

          <button
            @click="logout"
            class="w-full border border-red-200 hover:bg-red-50/50 hover:border-red-300 text-red-600 font-bold text-xs py-2.5 rounded-lg transition duration-150 cursor-pointer text-center font-sans"
          >
            {{ t('header.logout') }}
          </button>
        </div>
      </div>

      <!-- Change password -->
      <div class="lg:col-span-2">
        <div class="bg-white border border-brand-outline-variant/30 rounded-3xl p-7 shadow-sm">
          <div class="flex items-center gap-2 pb-5 border-b border-slate-100 select-none mb-6">
            <KeyRound :size="18" class="text-[#2563eb]" />
            <h3 class="font-sans text-sm font-bold text-stone-900">{{ t('account.changePassword') }}</h3>
          </div>
          <form @submit.prevent="changePassword" class="space-y-5 text-xs font-sans">
            <div class="space-y-1.5">
              <label class="text-xs text-stone-700 font-medium block">{{ t('changePassword.oldPassword') }}</label>
              <div class="relative">
                <input
                  v-model="currentPassword"
                  :type="showCurrent ? 'text' : 'password'"
                  :placeholder="t('changePassword.oldPlaceholder')"
                  class="w-full text-xs border border-slate-200 focus:border-[#2563eb] transition rounded-lg py-2.5 pl-3 pr-10 focus:outline-none bg-white text-stone-800 placeholder:text-stone-400"
                />
                <button type="button" @click="showCurrent = !showCurrent" class="absolute right-3 top-3 text-stone-400 hover:text-stone-600 cursor-pointer">
                  <component :is="showCurrent ? EyeOff : Eye" :size="15" />
                </button>
              </div>
              <div class="flex justify-end pt-0.5">
                <button type="button" @click="forgotPasswordOpen = true" class="text-xs font-bold text-[#2563eb] hover:text-[#1d4ed8] hover:underline cursor-pointer">{{ t('account.forgotPassword') }}</button>
              </div>
              <p v-if="currentError" class="text-[10px] text-red-500 -mt-1">{{ currentError }}</p>
            </div>

            <div class="space-y-1.5">
              <label class="text-xs text-stone-700 font-medium block">{{ t('changePassword.newPassword') }}</label>
              <div class="relative">
                <input
                  v-model="newPassword"
                  :type="showNew ? 'text' : 'password'"
                  :placeholder="t('account.newPasswordPlaceholder')"
                  class="w-full text-xs border border-slate-200 focus:border-[#2563eb] transition rounded-lg py-2.5 pl-3 pr-10 focus:outline-none bg-white text-stone-800 placeholder:text-stone-400"
                />
                <button type="button" @click="showNew = !showNew" class="absolute right-3 top-3 text-stone-400 hover:text-stone-600 cursor-pointer">
                  <component :is="showNew ? EyeOff : Eye" :size="15" />
                </button>
              </div>
              <p v-if="newError" class="text-[10px] text-red-500 mt-1">{{ newError }}</p>
              <div class="flex justify-between items-center text-[10px] select-none pt-0.5">
                <div class="flex items-center gap-1 text-stone-400"><AlertCircle :size="12" class="shrink-0" /><span>{{ t('changePassword.newPlaceholder') }}</span></div>
                <div class="text-stone-500 flex items-center gap-1"><span>{{ t('account.strengthLabel') }}:</span><span :class="strength.style">{{ strength.label }}</span></div>
              </div>
            </div>

            <div class="space-y-1.5">
              <label class="text-xs text-stone-700 font-medium block">{{ t('changePassword.confirmPassword') }}</label>
              <div class="relative">
                <input
                  v-model="confirmPassword"
                  :type="showConfirm ? 'text' : 'password'"
                  :placeholder="t('changePassword.confirmPlaceholder')"
                  class="w-full text-xs border border-slate-200 focus:border-[#2563eb] transition rounded-lg py-2.5 pl-3 pr-10 focus:outline-none bg-white text-stone-800 placeholder:text-stone-400"
                />
                <button type="button" @click="showConfirm = !showConfirm" class="absolute right-3 top-3 text-stone-400 hover:text-stone-600 cursor-pointer">
                  <component :is="showConfirm ? EyeOff : Eye" :size="15" />
                </button>
              </div>
              <p v-if="confirmError" class="text-[10px] text-red-500 mt-1">{{ confirmError }}</p>
            </div>

            <div class="flex gap-3 pt-4 border-t border-slate-100 mt-6 font-sans">
              <button type="submit" class="px-5 py-2.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-lg shadow-sm font-bold text-xs cursor-pointer transition duration-150">{{ t('account.confirmChange') }}</button>
              <button type="button" @click="currentPassword = ''; newPassword = ''; confirmPassword = ''; currentError = ''; newError = ''; confirmError = ''" class="px-5 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-stone-600 rounded-lg text-xs font-bold cursor-pointer transition duration-150">{{ t('common.reset') }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- 登录记录 (PRD 账号管理) -->
    <!-- <div class="bg-white border border-brand-outline-variant/50 rounded-2xl overflow-hidden shadow-sm">
      <div class="px-6 py-4 border-b border-brand-outline-variant/30 flex items-center gap-2">
        <LogIn :size="16" class="text-[#2563eb]" />
        <h3 class="text-sm font-bold text-stone-800">{{ t('logs.loginRecords') }}</h3>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead>
            <tr class="bg-brand-surface-container-low/50 border-b border-brand-outline-variant/30 text-brand-secondary font-bold">
              <th class="px-6 py-3">{{ t('account.username') }}</th>
              <th class="px-6 py-3">{{ t('common.result') }}</th>
              <th class="px-6 py-3">{{ t('common.reason') }}</th>
              <th class="px-6 py-3">IP</th>
              <th class="px-6 py-3">{{ t('common.createdAt') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-brand-outline-variant/30">
            <tr v-if="loginRecords.length === 0">
              <td colspan="5" class="px-6 py-10 text-center text-brand-secondary">{{ t('account.noLoginRecords') }}</td>
            </tr>
            <tr v-for="r in loginRecords" :key="r.id" class="hover:bg-brand-surface-container-low/30">
              <td class="px-6 py-3 font-medium text-brand-on-surface">{{ r.username }}</td>
              <td class="px-6 py-3">
                <span :class="['font-bold px-2 py-0.5 rounded-full text-[10px]',
                  r.result === 'success' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-500/10 text-rose-600']">
                  {{ r.result === 'success' ? t('overview.success') : t('overview.fail') }}
                </span>
              </td>
              <td class="px-6 py-3 text-brand-secondary">{{ r.reason ?? '—' }}</td>
              <td class="px-6 py-3 font-mono text-brand-secondary">{{ r.ip ?? '—' }}</td>
              <td class="px-6 py-3 font-mono text-brand-secondary">{{ formatDateTime(r.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div> -->

    <!-- Forgot password dialog -->
    <Dialog :open="forgotPasswordOpen" @update:open="forgotPasswordOpen = $event">
      <DialogContent class="max-w-[520px] rounded-[28px] border-slate-200 bg-white px-8 py-12 text-center shadow-2xl select-none sm:px-12" :show-close-button="true">
        <div class="mx-auto mb-8 flex h-24 w-24 items-center justify-center rounded-full bg-blue-50 text-[#2563eb]">
          <KeyRound :size="48" stroke-width="2.5" />
        </div>
        <p class="text-xl font-extrabold leading-relaxed tracking-tight text-stone-800 sm:text-2xl">
          {{ t('account.resetPasswordHint') }}
        </p>
      </DialogContent>
    </Dialog>

    <!-- Toast -->
    <Teleport to="body">
      <div v-if="toast" class="fixed bottom-6 right-6 z-50 animate-fade-in shadow-xl">
        <div :class="['flex items-center gap-2.5 px-4 py-3 rounded-xl border text-xs font-sans font-bold leading-normal', toastStyles[toast.type].box]">
          <component :is="toastStyles[toast.type].iconComp" :size="15" :class="toastStyles[toast.type].icon" />
          <span>{{ toast.message }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>
