import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css';
import App from './App.vue';
import { router } from './router';
import { useLicenseStore } from './stores/license';
import { i18n } from './i18n';

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(router);
useLicenseStore().load(); // read injected window.COMPDF_LICENSE before mount
app.mount('#app');
