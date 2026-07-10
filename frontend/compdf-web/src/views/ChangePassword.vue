<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { KeyRound, Eye, EyeOff, ArrowRight } from 'lucide-vue-next';

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

const oldPassword = ref('');
const newPassword = ref('');
const confirm = ref('');
const showOld = ref(false);
const showNew = ref(false);
const showConfirm = ref(false);
const loading = ref(false);
const oldError = ref('');
const newError = ref('');
const formError = ref('');

const mismatch = computed(() => confirm.value.length > 0 && newPassword.value !== confirm.value);
const tooShort = computed(() => newPassword.value.length > 0 && newPassword.value.length < 8);
const weak = computed(() => newPassword.value.length > 0 && (!/[A-Za-z]/.test(newPassword.value) || !/\d/.test(newPassword.value)));
const sameAsOld = computed(() => newPassword.value.length > 0 && newPassword.value === oldPassword.value);

async function submit() {
  if (tooShort.value || weak.value || mismatch.value || sameAsOld.value) return;
  loading.value = true;
  oldError.value = '';
  newError.value = '';
  formError.value = '';
  try {
    await auth.changePassword(oldPassword.value, newPassword.value);
    // PRD: 提示密码已修改 → 跳转登录页重新登录.
    auth.logout();
    router.push({ name: 'login' });
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { message?: string } }; message?: string };
    const status = e?.response?.status;
    const msg = e?.response?.data?.message ?? e?.message ?? '';
    if ((status === 400 || status === 401) && /current password incorrect/i.test(msg)) {
      oldError.value = t('changePassword.incorrectOld');
    } else if (status === 400 && /new password must differ/i.test(msg)) {
      newError.value = t('changePassword.sameAsOld');
    } else {
      formError.value = msg || t('changePassword.failed');
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4 bg-brand-background">
    <div class="bg-white rounded-3xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col border border-slate-100">
      <div class="bg-gradient-to-br from-[#2563eb] to-[#124bcf] px-8 py-7 text-white">
        <div class="flex items-center gap-2 mb-2">
          <div class="w-5 h-5 bg-white/15 rounded flex items-center justify-center"><KeyRound :size="12" /></div>
          <span class="text-[10px] uppercase font-bold tracking-wider text-blue-100">{{ t('changePassword.eyebrow') }}</span>
        </div>
        <h3 class="font-sans text-xl font-bold tracking-tight">{{ t('changePassword.title') }}</h3>
        <p class="text-[11.5px] text-blue-100 font-sans leading-relaxed mt-2.5 opacity-90">
          {{ t('changePassword.description') }}
        </p>
      </div>

      <form @submit.prevent="submit" class="p-8 space-y-5 text-xs font-sans">
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-stone-700 block">{{ t('changePassword.oldPassword') }}</label>
          <div class="relative">
            <input
              v-model="oldPassword"
              :type="showOld ? 'text' : 'password'"
              required
              :placeholder="t('changePassword.oldPlaceholder')"
              :disabled="loading"
              class="w-full pl-3 pr-10 py-3 border border-slate-200 focus:border-[#2563eb] rounded-xl text-stone-800 bg-white text-xs outline-none transition disabled:opacity-60"
            />
            <button type="button" @click="showOld = !showOld" class="absolute right-3 top-3.5 text-stone-400 hover:text-stone-600 cursor-pointer">
              <component :is="showOld ? EyeOff : Eye" :size="15" />
            </button>
          </div>
          <p v-if="oldError" class="text-[10px] text-red-500 mt-1">{{ oldError }}</p>
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-stone-700 block">{{ t('changePassword.newPassword') }}</label>
          <div class="relative">
            <input
              v-model="newPassword"
              :type="showNew ? 'text' : 'password'"
              required
              :placeholder="t('changePassword.newPlaceholder')"
              :disabled="loading"
              class="w-full pl-3 pr-10 py-3 border border-slate-200 focus:border-[#2563eb] rounded-xl text-stone-800 bg-white text-xs outline-none transition disabled:opacity-60"
            />
            <button type="button" @click="showNew = !showNew" class="absolute right-3 top-3.5 text-stone-400 hover:text-stone-600 cursor-pointer">
              <component :is="showNew ? EyeOff : Eye" :size="15" />
            </button>
          </div>
          <p v-if="newError" class="text-[10px] text-red-500 mt-1">{{ newError }}</p>
          <p v-else-if="tooShort" class="text-[10px] text-red-500 mt-1">{{ t('account.passwordLength') }}</p>
          <p v-else-if="weak" class="text-[10px] text-red-500 mt-1">{{ t('changePassword.weak') }}</p>
          <p v-else-if="sameAsOld" class="text-[10px] text-red-500 mt-1">{{ t('changePassword.sameAsOld') }}</p>
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-stone-700 block">{{ t('changePassword.confirmPassword') }}</label>
          <div class="relative">
            <input
              v-model="confirm"
              :type="showConfirm ? 'text' : 'password'"
              required
              :placeholder="t('changePassword.confirmPlaceholder')"
              :disabled="loading"
              class="w-full pl-3 pr-10 py-3 border border-slate-200 focus:border-[#2563eb] rounded-xl text-stone-800 bg-white text-xs outline-none transition disabled:opacity-60"
            />
            <button type="button" @click="showConfirm = !showConfirm" class="absolute right-3 top-3.5 text-stone-400 hover:text-stone-600 cursor-pointer">
              <component :is="showConfirm ? EyeOff : Eye" :size="15" />
            </button>
          </div>
          <p v-if="mismatch" class="text-[10px] text-red-500 mt-1">{{ t('changePassword.mismatch') }}</p>
        </div>
        <div v-if="formError" class="text-[11px] text-red-600 bg-red-50 border border-red-100 px-3.5 py-2.5 rounded-xl flex items-center gap-2">
          <span class="w-1.5 h-1.5 bg-red-500 rounded-full shrink-0 animate-pulse" />
          <span>{{ formError }}</span>
        </div>
        <button
          type="submit"
          :disabled="loading || tooShort || weak || mismatch || sameAsOld"
          class="w-full bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-bold text-xs py-3.5 rounded-xl transition shadow-md hover:shadow-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
        >
          <span>{{ loading ? t('changePassword.submitting') : t('changePassword.submitConfirm') }}</span>
          <ArrowRight :size="13" />
        </button>
      </form>
    </div>
  </div>
</template>
