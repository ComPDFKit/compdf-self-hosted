import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import svgLoader from 'vite-svg-loader'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath, URL } from 'node:url'

/**
 * Dev-only plugin: inject `window.COMPDF_CONFIG` + `window.COMPDF_LICENSE` into
 * index.html (replacing the <!--COMPDF_xxx--> markers) so the SPA behaves like
 * in production (where SpaController does the injection). Without this, dev mode
 * has no `window.COMPDF_CONFIG.apiKey`, so the axios interceptor can't attach
 * `x-api-key` to tool/conversion routes → 401 "API key 为空".
 *
 * API key plaintext source (first hit wins):
 *   1. `API_KEY` env var
 *   2. `DEV_API_KEY_FILE` env var (path to the plaintext file)
 *   3. `../../server/storage/.api-key-plaintext` (the file init-db.ts writes
 *      when STORAGE_DIR=./storage, the dev default)
 * If none is available, apiKey is null and tool calls 401 — the plugin logs a
 * warning so the dev knows to run `npm run init:db:dev` in server/ first.
 */
function devConfigPlugin(): Plugin {
  let apiKey = (process.env.API_KEY ?? '').trim() || null
  if (!apiKey) {
    const envPath = process.env.DEV_API_KEY_FILE
    const candidates = [
      envPath,
      resolve(process.cwd(), '../../server/storage/.api-key-plaintext'),
    ].filter(Boolean) as string[]
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          const raw = readFileSync(p, 'utf8').trim()
          if (raw) { apiKey = raw; break }
        } catch { /* try next */ }
      }
    }
  }

  const fallbackConfig = {
    siteName: 'ComPDF Self-Hosted (dev)',
    logoUrl: null as string | null,
    themeColor: '#1668ff',
    locale: 'en',
    darkMode: false,
    upgradeBannerText: null as string | null,
    docUrl: null as string | null,
    contactUrl: null as string | null,
    compdfToolsEnabled: process.env.COMPDF_TOOLS_ENABLED?.trim().toLowerCase() !== 'false',
    licenseType: 'UNKNOWN',
    licenseTypeValue: 0,
    isFormalLicense: false,
    apiKey,
  }
  // Minimal display-only license payload so the license store loads in dev.
  const license = { sub: 'dev', exp: 0, status: 'valid', present: true, scope: ['pdf', 'conversion'], limits: {} }
  const safe = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

  // Fetch the live brand config + the authoritative API key from the backend
  // on each index.html render so saved settings persist across refresh in dev
  // (mirrors production: SpaController injects the same payload). The apiKey
  // comes from the backend (env or its persisted plaintext file) — NOT the
  // local server/storage file, which can diverge from the running backend.
  // Falls back to the local file/env only if the backend is unreachable.
  const BACKEND = process.env.COMPDF_BACKEND_URL ?? 'http://localhost:8080'
  async function fetchBrandConfig(): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`${BACKEND}/api/v1/dashboard/branding/config`)
      if (res.ok) {
        const payload = await res.json() as Record<string, unknown>
        const brand = (
          payload && typeof payload.data === 'object' && payload.data !== null
            ? payload.data
            : payload
        ) as Record<string, unknown>
        // Prefer the backend's authoritative apiKey; fall back to the local
        // file/env only if the backend didn't return one.
        const resolvedApiKey = (typeof brand.apiKey === 'string' && brand.apiKey) || apiKey
        return { ...fallbackConfig, ...brand, apiKey: resolvedApiKey }
      }
    } catch {
      // backend down — use fallback so the SPA still loads
    }
    return { ...fallbackConfig, apiKey }
  }

  return {
    name: 'compdf-dev-config',
    apply: 'serve',
    config() {
      if (!apiKey) {
        // eslint-disable-next-line no-console
        console.warn(
          '\n[compdf-dev-config] API key not found — tool calls will 401 ("API key 为空").\n' +
          '  Run `npm run init:db:dev` in server/ to generate + persist the key, OR set API_KEY env.\n',
        )
      }
    },
    async transformIndexHtml(html: string) {
      const config = await fetchBrandConfig()
      const configScript = `<script>window.COMPDF_CONFIG=${safe(config)};</script>`
      const licenseScript = `<script>window.COMPDF_LICENSE=${safe(license)};</script>`
      return html
        .replace('<!--COMPDF_CONFIG-->', configScript)
        .replace('<!--COMPDF_LICENSE-->', licenseScript)
    },
  }
}

// Dev: proxy /api to the local server on :8080. In production the SPA is served
// from the same origin by SpaController, so the proxy is dev-only.
export default defineConfig({
  plugins: [vue(), svgLoader({ svgo: false }), tailwindcss(), devConfigPlugin()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
})
