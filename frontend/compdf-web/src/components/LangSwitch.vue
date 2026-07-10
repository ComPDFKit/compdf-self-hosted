<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { LANGUAGES, storeLocale } from '@/config/i18n-keys';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import LanguageIcon from '@/assets/icons/header/language.svg?component';

const { locale, t } = useI18n();

function pick(code: string) {
  locale.value = code;
  storeLocale(code);
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon" :aria-label="t('langSwitch.ariaLabel')">
        <LanguageIcon class="size-[22px] text-[#52555f]" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="min-w-[150px]">
      <DropdownMenuItem
        v-for="lang in LANGUAGES"
        :key="lang.code"
        :class="locale === lang.code ? 'font-semibold text-[#396ffa]' : ''"
        @select="pick(lang.code)"
      >
        {{ lang.label }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
