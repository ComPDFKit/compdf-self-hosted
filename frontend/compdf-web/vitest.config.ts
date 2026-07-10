import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // tvision-color → @material/material-color-utilities ships a broken native
  // ESM internal import ("dist/blend/blend" path doesn't resolve). Inlining it
  // forces vite to transform the dep so the import resolves.
  server: { deps: { inline: [/tvision-color/, /@material/] } },
  test: { environment: 'node', include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'], setupFiles: ['./test/setup.ts'] },
});
