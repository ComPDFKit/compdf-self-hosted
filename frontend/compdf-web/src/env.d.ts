/// <reference types="vite/client" />

// vite-svg-loader: `import Comp from '*.svg?component'` returns a stateless Vue
// component. vite/client only declares `*.svg` (URL string), `?url`, `?raw`,
// `?inline` — not the loader's `?component` suffix, so declare it here.
declare module '*.svg?component' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
