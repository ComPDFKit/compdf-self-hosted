/**
 * BrandSettingsService — read/write the `system_settings` row (id=1) AND
 * persist brand fields to `configs/settings.yml` (Plan A: the file is the
 * single source of truth — Dashboard saves write file + DB; on restart
 * SettingsFileSyncService re-applies the file to the DB). Both SPAs consume
 * the public shape via SpaController's `window.COMPDF_CONFIG` injection
 * (getPublicConfig()).
 *
 * 5s read cache: brand config is read on EVERY SPA index.html render, so a DB
 * round-trip per request is wasteful. Cache is invalidated on every write.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { MysqlClient } from '../clients/mysql.client';
import { ConversionClient } from '../clients/conversion.client';
import type { UpdateSettingsDto } from './dashboard.dto';

export interface BrandSettings {
  siteName: string;
  logoPath: string | null;
  themeColor: string;
  locale: string;
  darkMode: boolean;
  fileRetentionDays: number;
  upgradeBannerText: string | null;
  docUrl: string | null;
  contactUrl: string | null;
  announcementsJson: string | null;
  updatedAt: Date;
}

/** Shape injected into both SPAs' index.html as `window.COMPDF_CONFIG`. */
export interface PublicBrandConfig {
  siteName: string;
  logoUrl: string | null;
  themeColor: string;
  locale: string;
  darkMode: boolean;
  upgradeBannerText: string | null;
  docUrl: string | null;
  contactUrl: string | null;
  compdfToolsEnabled: boolean;
  licenseType: 'UNKNOWN' | 'TRIAL' | 'FORMAL';
  licenseTypeValue: 0 | 1 | 2;
  isFormalLicense: boolean;
  /** Deployment API key plaintext (for the ComPDF Web SPA's x-api-key header). Set by SpaController. */
  apiKey?: string | null;
}

interface SettingsRow {
  site_name: string;
  logo_path: string | null;
  theme_color: string;
  locale: string;
  dark_mode: number;
  file_retention_days: number;
  upgrade_banner_text: string | null;
  doc_url: string | null;
  contact_url: string | null;
  announcements_json: string | null;
  updated_at: Date;
}

const SELECT_SQL = `SELECT site_name, logo_path, theme_color, locale, dark_mode, file_retention_days, upgrade_banner_text, doc_url, contact_url, announcements_json, updated_at FROM system_settings WHERE id = 1 LIMIT 1`;

const CACHE_TTL_MS = 5000;

@Injectable()
export class BrandSettingsService {
  private readonly logger = new Logger(BrandSettingsService.name);
  private cache: BrandSettings | null = null;
  private cachedAt = 0;
  private readonly storageDir: string;

  constructor(
    private readonly mysql: MysqlClient,
    private readonly config: ConfigService,
    private readonly conversion: ConversionClient,
  ) {
    this.storageDir = this.config.get<string>('storageDir') ?? 'storage';
  }

  async getSettings(): Promise<BrandSettings> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < CACHE_TTL_MS) return this.cache;
    const rows = await this.mysql.query<SettingsRow[]>(SELECT_SQL);
    const row = rows[0];
    if (!row) {
      // Should never happen — init.sql seeds id=1. Fall back to safe defaults
      // rather than crashing the SPA render.
      this.logger.warn('system_settings row missing; returning defaults');
      return DEFAULT_SETTINGS;
    }
    this.cache = mapRow(row);
    this.cachedAt = now;
    return this.cache;
  }

  async getPublicConfig(): Promise<PublicBrandConfig> {
    const s = await this.getSettings();
    const licenseType = await this.conversion.getLicenseType();
    // Only advertise a logo URL if the file actually exists on disk. A stale
    // logoPath (e.g. after a storage volume was reset) would otherwise produce
    // a broken <img> / 404 "logo file missing" in the SPA.
    const logoExists = !!s.logoPath && existsSync(join(this.storageDir, 'branding', s.logoPath));
    return {
      siteName: s.siteName,
      // Cache-buster via updatedAt so a re-uploaded logo isn't served stale.
      logoUrl: logoExists ? `/api/v1/dashboard/branding/logo?v=${s.updatedAt.getTime()}` : null,
      themeColor: s.themeColor,
      locale: s.locale,
      darkMode: s.darkMode,
      upgradeBannerText: s.upgradeBannerText,
      docUrl: s.docUrl,
      contactUrl: s.contactUrl,
      compdfToolsEnabled: this.config.get<boolean>('compdfTools.enabled') ?? true,
      licenseType: licenseType.licenseType,
      licenseTypeValue: licenseType.value,
      isFormalLicense: licenseType.isFormalLicense,
    };
  }

  async updateSettings(patch: UpdateSettingsDto): Promise<BrandSettings> {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.siteName !== undefined) { sets.push('site_name = ?'); params.push(patch.siteName); }
    if (patch.themeColor !== undefined) { sets.push('theme_color = ?'); params.push(patch.themeColor); }
    if (patch.locale !== undefined) { sets.push('locale = ?'); params.push(patch.locale); }
    if (patch.darkMode !== undefined) { sets.push('dark_mode = ?'); params.push(patch.darkMode ? 1 : 0); }
    // Empty string → NULL (clears the field).
    if (patch.upgradeBannerText !== undefined) { sets.push('upgrade_banner_text = ?'); params.push(patch.upgradeBannerText || null); }
    if (patch.docUrl !== undefined) { sets.push('doc_url = ?'); params.push(patch.docUrl || null); }
    if (patch.contactUrl !== undefined) { sets.push('contact_url = ?'); params.push(patch.contactUrl || null); }
    if (sets.length === 0) return this.getSettings();
    await this.mysql.execute(`UPDATE system_settings SET ${sets.join(', ')} WHERE id = 1`, params);
    this.invalidateCache();
    const updated = await this.getSettings();
    this.writeSettingsFile(updated);
    return updated;
  }

  async updateLogo(filename: string): Promise<BrandSettings> {
    await this.mysql.execute('UPDATE system_settings SET logo_path = ? WHERE id = 1', [filename]);
    this.invalidateCache();
    const updated = await this.getSettings();
    // logo_path is NOT written to settings.yml (the file manages logo via
    // branding.logo_file, a binary reference; Dashboard upload sets DB only).
    return updated;
  }

  /**
   * Persist the current brand fields to settings.yml (Plan A). Read-merge-write
   * so operator-managed keys (e.g. branding.logo_file) are preserved. Best-effort:
   * a write failure is logged and swallowed — the DB is already updated.
   */
  private writeSettingsFile(s: BrandSettings): void {
    const path = this.config.get<string>('settings.path');
    if (!path) return;
    let existing: Record<string, unknown> = {};
    try {
      existing = (yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown>) ?? {};
    } catch {
      // missing/malformed file → start from a fresh object
      existing = {};
    }
    const branding = { ...(existing.branding as object | undefined), site_name: s.siteName, theme_color: s.themeColor };
    const ui = { ...(existing.ui as object | undefined), locale: s.locale, dark_mode: s.darkMode };
    const retention = { ...(existing.retention as object | undefined), file_retention_days: s.fileRetentionDays };
    const marketing = {
      ...(existing.marketing as object | undefined),
      upgrade_banner_text: s.upgradeBannerText,
      doc_url: s.docUrl,
      contact_url: s.contactUrl,
    };
    const merged = { branding, ui, retention, marketing };
    try {
      writeFileSync(path, yaml.dump(merged, { lineWidth: 120 }), 'utf8');
    } catch (err) {
      this.logger.warn(`settings.yml write failed (DB was still updated): ${(err as Error).message}`);
    }
  }

  invalidateCache(): void {
    this.cache = null;
    this.cachedAt = 0;
  }
}

function mapRow(r: SettingsRow): BrandSettings {
  return {
    siteName: r.site_name,
    logoPath: r.logo_path,
    themeColor: r.theme_color,
    locale: r.locale,
    darkMode: !!r.dark_mode,
    fileRetentionDays: r.file_retention_days,
    upgradeBannerText: r.upgrade_banner_text,
    docUrl: r.doc_url,
    contactUrl: r.contact_url,
    announcementsJson: r.announcements_json,
    updatedAt: r.updated_at,
  };
}

const DEFAULT_SETTINGS: BrandSettings = {
  siteName: 'ComPDF Self-Hosted',
  logoPath: null,
  themeColor: '#1976D2',
  locale: 'en',
  darkMode: false,
  fileRetentionDays: 7,
  upgradeBannerText: null,
  docUrl: null,
  contactUrl: null,
  announcementsJson: null,
  updatedAt: new Date(0),
};
