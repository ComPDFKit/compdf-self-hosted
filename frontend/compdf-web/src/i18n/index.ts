import { createI18n } from 'vue-i18n';
import en from './locales/en.json';
import zhcn from './locales/zh-cn.json';
import zhtw from './locales/zh-tw.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import th from './locales/th.json';
import es from './locales/es.json';
import { LANGUAGES, DASHBOARD_LANGUAGES, getStoredLocale, DEFAULT_LOCALE } from '../config/i18n-keys';

export type Locale = string;

export { LANGUAGES, DASHBOARD_LANGUAGES };

export const i18n = createI18n({
  legacy: false,
  locale: getStoredLocale() || DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: { en, 'zh-cn': zhcn, 'zh-tw': zhtw, ja, ko, th, es },
});

/** Switch the active locale + persist the choice. */
export function setLocale(code: Locale): void {
  (i18n.global.locale.value as string) = code;
  if (typeof localStorage !== 'undefined') localStorage.setItem('compdf-lang', code);
}
