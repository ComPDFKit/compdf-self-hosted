/**
 * SpaController — serves the unified SPA (ComPDF Web + Dashboard merged) and
 * injects the display-only license payload + brand config + API key into
 * index.html.
 *
 *   GET /                          → public/compdf-web/index.html
 *   GET /pdf-tools/:convert        → same index.html (history route fallback)
 *   GET /admin, /admin/*           → same index.html (history route fallback)
 *
 * All enabled routes serve the SAME index.html and the client-side router
 * dispatches by path. When COMPDF_TOOLS_ENABLED is false, public Web routes
 * redirect to /admin while admin routes continue serving the SPA.
 *
 * Two injections per render, both with the same \u00XX-escape so no string
 * field can break out of the <script> context:
 *   - `window.COMPDF_LICENSE` — display-only payload (sub/exp/scope/limits/...).
 *     Contains NO limit toggles and NOT the raw token.
 *   - `window.COMPDF_CONFIG`  — public brand config (siteName/logoUrl/themeColor/
 *     locale/darkMode/upgradeBannerText/docUrl/contactUrl/compdfToolsEnabled/apiKey).
 *     Logo is fetched unauthenticated from /api/v1/dashboard/branding/logo, so
 *     the pre-login SPA can render the brand. apiKey is the deployment key
 *     plaintext (env or init-db-generated), auto-attached as x-api-key by the
 *     SPA for tool/conversion routes.
 *
 * Each injection honours its `<!--COMPDF_xxx-->` marker when present, else
 * injects before `</head>`, else appends. The static `public/*` dir is
 * populated by the frontend build; a missing index.html yields a clean 503
 * "frontend not built" rather than crashing boot.
 */
import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { LicenseTokenService, LicenseDisplay } from '../license/license-token.service';
import { BrandSettingsService, PublicBrandConfig } from '../dashboard/brand-settings.service';
import { ApiKeyService } from '../auth/api-key.service';

@Controller()
export class SpaController {
  private readonly indexHtml: string;
  private readonly compdfToolsEnabled: boolean;

  constructor(
    private readonly licenseToken: LicenseTokenService,
    private readonly brands: BrandSettingsService,
    private readonly apiKeys: ApiKeyService,
    config: ConfigService,
  ) {
    const publicDir = config.get<string>('publicDir') ?? join(process.cwd(), 'public');
    this.indexHtml = join(publicDir, 'compdf-web', 'index.html');
    this.compdfToolsEnabled = config.get<boolean>('compdfTools.enabled') ?? true;
  }

  @Get()
  async webRoot(@Res() res: Response): Promise<void> {
    if (!this.compdfToolsEnabled) {
      res.redirect(302, '/admin');
      return;
    }
    await this.serve(res);
  }

  @Get(['pdf-tools', 'pdf-tools/:convert'])
  async webRoute(@Res() res: Response): Promise<void> {
    if (!this.compdfToolsEnabled) {
      res.redirect(302, '/admin');
      return;
    }
    await this.serve(res);
  }

  @Get(['admin', 'admin/*'])
  async adminRoute(@Res() res: Response): Promise<void> {
    await this.serve(res);
  }

  private async serve(res: Response): Promise<void> {
    if (!existsSync(this.indexHtml)) {
      res
        .status(503)
        .set('Content-Type', 'application/json')
        .send({
          code: 'FRONTEND_NOT_BUILT',
          message: 'frontend assets not built; the SPA index.html is missing. Build the frontend into public/compdf-web/.',
        });
      return;
    }
    const html = readFileSync(this.indexHtml, 'utf8');
    const [license, brand] = await Promise.all([
      this.licenseToken.decodeForDisplay(),
      this.brands.getPublicConfig(),
    ]);
    // Attach the deployment API key plaintext so the ComPDF Web SPA can call
    // the sync PDF/conversion routes (ApiKeyGuard) without manual key entry.
    // null when neither API_KEY env nor the persisted plaintext is available.
    const config: PublicBrandConfig = { ...brand, apiKey: this.apiKeys.getPlaintextKey() };
    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'no-store')
      .send(injectLicense(injectBrandConfig(html, config), license));
  }
}

/** Escape `<`, `>`, `&` to `\u00XX` so JSON strings can't break the script context. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function embed(html: string, marker: string, globalVar: string, value: unknown): string {
  const script = `<script>${globalVar}=${safeJson(value)};</script>`;
  if (html.includes(marker)) return html.replace(marker, script);
  if (html.includes('</head>')) return html.replace('</head>', `${script}</head>`);
  return `${html}${script}`;
}

export function injectLicense(html: string, payload: LicenseDisplay): string {
  return embed(html, '<!--COMPDF_LICENSE-->', 'window.COMPDF_LICENSE', payload);
}

export function injectBrandConfig(html: string, config: PublicBrandConfig): string {
  return embed(html, '<!--COMPDF_CONFIG-->', 'window.COMPDF_CONFIG', config);
}
