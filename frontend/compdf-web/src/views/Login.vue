<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useBrandStore } from '@/stores/brand';
import { useSetupStore } from '@/stores/setup';
import { User, Lock, ArrowRight, Info } from 'lucide-vue-next';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const brand = useBrandStore();
const setup = useSetupStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');
const showDefaultHint = ref(false);

const redirect = computed(() => (route.query.redirect as string) || '/admin');

onMounted(async () => {
  try {
    showDefaultHint.value = await setup.check();
  } catch {
    showDefaultHint.value = false;
  }
});

async function submit() {
  if (!username.value || !password.value) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    const res = await auth.login(username.value, password.value);
    if (res.mustChangePassword) {
      router.push({ name: 'change-password' });
    } else {
      router.push(redirect.value);
    }
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    errorMsg.value = status === 401 ? t('login.invalidCreds') : (err as Error)?.message ?? t('login.failed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4 bg-brand-background">
    <div class="bg-white rounded-3xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col border border-slate-100">
      <!-- Gradient header -->
      <div class="bg-gradient-to-br from-[#2563eb] to-[#124bcf] px-8 py-7 text-white relative">
        <div class="flex items-center gap-2 mb-3">
          <div class="w-5 h-5 bg-white/15 rounded flex items-center justify-center text-white">
            <Lock :size="12" />
          </div>
          <span class="text-[10px] uppercase font-bold tracking-wider text-blue-100">{{ t('login.eyebrow') }}</span>
        </div>
        <h3 class="font-sans text-xl font-bold tracking-tight">{{ brand.c.siteName || t('login.fallbackTitle') }}</h3>
        <p class="text-[11.5px] text-blue-100 font-sans leading-relaxed mt-2.5 opacity-90">
          {{ t('login.description') }}
        </p>
      </div>

      <!-- Form -->
      <form @submit.prevent="submit" class="p-8 space-y-5 text-xs font-sans">
        <div
          v-if="showDefaultHint"
          data-test="default-login-hint"
          class="rounded-2xl border border-blue-100 bg-blue-50/80 px-4 py-3 text-[11px] text-blue-900"
        >
          <div class="flex items-start gap-2">
            <Info :size="14" class="mt-0.5 shrink-0 text-blue-700" />
            <div class="space-y-1">
              <p class="font-semibold">{{ t('login.defaultCredentialsTitle') }}</p>
              <p class="leading-relaxed text-blue-800/90">{{ t('login.defaultCredentialsBody') }}</p>
              <p class="font-medium text-blue-900">
                {{ t('login.defaultCredentialsUsername') }}: <span class="font-bold">admin</span>
              </p>
              <p class="font-medium text-blue-900">
                {{ t('login.defaultCredentialsPassword') }}: <span class="font-bold">admin</span>
              </p>
            </div>
          </div>
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-stone-700 block">{{ t('login.adminUsername') }}</label>
          <div class="relative">
            <User :size="14" class="absolute left-3 top-3.5 text-stone-400" />
            <input
              v-model="username"
              type="text"
              required
              :placeholder="t('login.usernamePlaceholder')"
              class="w-full pl-9 pr-4 py-3 border border-slate-200 focus:border-[#2563eb] rounded-xl text-stone-800 bg-white text-xs outline-none transition"
            />
          </div>
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-stone-700 block">{{ t('login.adminPassword') }}</label>
          <div class="relative">
            <Lock :size="14" class="absolute left-3 top-3.5 text-stone-400" />
            <input
              v-model="password"
              type="password"
              required
              :placeholder="t('login.passwordPlaceholder')"
              class="w-full pl-9 pr-4 py-3 border border-slate-200 focus:border-[#2563eb] rounded-xl text-stone-800 bg-white text-xs outline-none transition"
            />
          </div>
        </div>
        <div v-if="errorMsg" class="text-[11px] text-red-600 bg-red-50 border border-red-100 px-3.5 py-2.5 rounded-xl flex items-center gap-2">
          <span class="w-1.5 h-1.5 bg-red-500 rounded-full shrink-0 animate-pulse" />
          <span>{{ errorMsg }}</span>
        </div>
        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-bold text-xs py-3.5 rounded-xl transition shadow-md hover:shadow-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
        >
          <span>{{ loading ? t('login.signingIn') : t('login.submitConnect') }}</span>
          <ArrowRight :size="13" />
        </button>
      </form>
    </div>
  </div>
</template>
