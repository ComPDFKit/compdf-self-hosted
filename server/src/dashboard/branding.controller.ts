/**
 * BrandingController — PUBLIC brand asset routes (NO JwtAuthGuard).
 *
 *   GET /api/v1/dashboard/branding/logo → stream the configured logo file
 *
 * Both SPAs need the logo pre-login (dashboard login page, compdf-web header),
 * so this controller is intentionally unguarded. The logo file lives at
 * <storageDir>/branding/<logo_path>; logo_path is set by the authed
 * POST /api/v1/dashboard/settings/logo route on DashboardController.
 *
 * Note: this lives under the api/v1/dashboard/ prefix but is a separate
 * controller so the class-level JwtAuthGuard on DashboardController does not
 * apply. Route registration is exact — no conflict with DashboardController.
 */
import { Controller, Get, Header, NotFoundException, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ApiKeyService } from '../auth/api-key.service';
import { BrandSettingsService, PublicBrandConfig } from './brand-settings.service';

@Controller('api/v1/dashboard/branding')
export class BrandingController {
  private readonly storageDir: string;

  constructor(
    private readonly brands: BrandSettingsService,
    private readonly apiKeys: ApiKeyService,
    config: ConfigService,
  ) {
    this.storageDir = config.get<string>('storageDir') ?? 'storage';
  }

  /**
   * Public brand config (siteName/logoUrl/themeColor/locale/darkMode/...) +
   * the deployment API key plaintext. Same payload SpaController injects into
   * index.html in production — exposed as an endpoint so the frontend dev server
   * can fetch + inject it. The apiKey is the authoritative key the backend
   * validates against (env or the persisted plaintext file), so dev mode
   * always uses the correct key even when the local file is stale/missing.
   */
  @Get('config')
  @Header('Cache-Control', 'no-store')
  async config(): Promise<PublicBrandConfig> {
    const brand = await this.brands.getPublicConfig();
    return { ...brand, apiKey: this.apiKeys.getPlaintextKey() };
  }

  @Get('logo')
  async logo(@Res() res: Response): Promise<void> {
    const s = await this.brands.getSettings();
    if (!s.logoPath) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'no logo configured' });
    }
    const file = join(this.storageDir, 'branding', s.logoPath);
    if (!existsSync(file)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'logo file missing' });
    }
    const ct = s.logoPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    res.set('Content-Type', ct);
    // Browsers cache for 5 min; the config-injected logoUrl carries a ?v=<ts>
    // cache-buster so a re-upload is picked up immediately.
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).send(readFileSync(file));
  }
}
