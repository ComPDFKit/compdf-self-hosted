/**
 * SettingsFileSyncService — applies an external settings.yml to the
 * `system_settings` DB row at server startup (OnModuleInit), and installs a
 * file-based logo if `branding.logo_file` is set.
 *
 * Semantics: **the file wins on every restart** for keys present in the file.
 * Dashboard edits still write the DB and take effect immediately for the
 * running session, but on next restart the file re-applies for the keys it
 * defines. Keys omitted from the file keep their DB value.
 *
 * Logo: `branding.logo_file` points at a logo (SVG/PNG) in the configs dir (or
 * an absolute path). On startup it's copied into <storageDir>/branding/logo.<ext>
 * and logo_path is set — so the operator drops a file in the mounted configs
 * volume + edits settings.yml, restarts, done. No Dashboard upload needed.
 *
 * Resilience: a missing file, malformed YAML, missing logo, or unreachable DB
 * is logged and swallowed so startup is never blocked.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import * as yaml from 'js-yaml';
import { MysqlClient } from '../clients/mysql.client';

interface ParsedSettings {
  branding?: { site_name?: string; theme_color?: string; logo_file?: string };
  ui?: { locale?: string; dark_mode?: boolean };
  retention?: { file_retention_days?: number };
  marketing?: {
    upgrade_banner_text?: string | null;
    doc_url?: string | null;
    contact_url?: string | null;
  };
  updates?: { enabled?: boolean; check_url?: string };
}

/** Column name + value pairs to UPDATE. Only keys present in the file. */
function extractColumns(p: ParsedSettings | null): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (!p) return out;
  if (p.branding?.site_name !== undefined) out.site_name = p.branding.site_name;
  if (p.branding?.theme_color !== undefined) out.theme_color = p.branding.theme_color;
  if (p.ui?.locale !== undefined) out.locale = p.ui.locale;
  if (p.ui?.dark_mode !== undefined) out.dark_mode = p.ui.dark_mode ? 1 : 0;
  if (p.retention?.file_retention_days !== undefined) {
    out.file_retention_days = p.retention.file_retention_days;
  }
  if (p.marketing?.upgrade_banner_text !== undefined) {
    out.upgrade_banner_text = p.marketing.upgrade_banner_text;
  }
  if (p.marketing?.doc_url !== undefined) out.doc_url = p.marketing.doc_url;
  if (p.marketing?.contact_url !== undefined) out.contact_url = p.marketing.contact_url;
  return out;
}

@Injectable()
export class SettingsFileSyncService implements OnModuleInit {
  private readonly logger = new Logger(SettingsFileSyncService.name);
  private readonly storageDir: string;
  /** In-memory copy of the `updates` section (not stored in DB — runtime config). */
  private updatesConfig: { enabled: boolean; checkUrl: string | null } = { enabled: true, checkUrl: null };

  constructor(
    private readonly mysql: MysqlClient,
    private readonly config: ConfigService,
  ) {
    this.storageDir = this.config.get<string>('storageDir') ?? 'storage';
  }

  /** The `updates` section from the last settings.yml read (runtime config for UpdateCheckService). */
  getUpdatesConfig(): { enabled: boolean; checkUrl: string | null } {
    return this.updatesConfig;
  }

  async onModuleInit(): Promise<void> {
    const path = this.config.get<string>('settings.path');
    if (!path || !existsSync(path)) {
      this.logger.warn(`settings file not found at ${path ?? '(unset)'}; skipping file sync`);
      return;
    }
    const raw = readFileSync(path, 'utf8');
    const applied = await this.syncFromContent(raw, path);
    if (applied.fields > 0) this.logger.log(`applied ${applied.fields} settings field(s) from ${path}`);
    if (applied.logo) this.logger.log(`installed logo from ${path}`);
  }

  /**
   * Parse YAML content, apply recognized keys to system_settings, and install
   * the logo if branding.logo_file is set. Returns counts. Never throws.
   */
  async syncFromContent(raw: string, path?: string): Promise<{ fields: number; logo: boolean }> {
    let parsed: ParsedSettings | null;
    try {
      parsed = yaml.load(raw) as ParsedSettings | null;
    } catch (err) {
      this.logger.warn(`settings file malformed, skipping sync: ${(err as Error).message}`);
      return { fields: 0, logo: false };
    }

    // Cache the updates section for UpdateCheckService (not a DB column).
    if (parsed?.updates) {
      this.updatesConfig = {
        enabled: parsed.updates.enabled !== false,
        checkUrl: parsed.updates.check_url?.trim() || null,
      };
    }

    const fields = await this.applyFields(parsed);
    const logo = path ? await this.installLogo(parsed?.branding?.logo_file, path) : false;
    return { fields, logo };
  }

  private async applyFields(p: ParsedSettings | null): Promise<number> {
    const patch = extractColumns(p);
    const keys = Object.keys(patch);
    if (keys.length === 0) return 0;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    try {
      await this.mysql.execute(
        `UPDATE system_settings SET ${sets} WHERE id = 1`,
        Object.values(patch),
      );
    } catch (err) {
      this.logger.warn(`settings file sync failed (DB), continuing with DB values: ${(err as Error).message}`);
      return 0;
    }
    return keys.length;
  }

  private async installLogo(logoFile: string | undefined, settingsPath: string): Promise<boolean> {
    if (!logoFile) return false;
    const src = isAbsolute(logoFile) ? logoFile : join(dirname(settingsPath), logoFile);
    if (!existsSync(src)) {
      this.logger.warn(`logo file not found at ${src}; skipping logo install`);
      return false;
    }
    const ext = logoFile.toLowerCase().endsWith('.png') ? 'png' : 'svg';
    const destDir = join(this.storageDir, 'branding');
    const dest = join(destDir, `logo.${ext}`);
    try {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(src, dest);
      await this.mysql.execute('UPDATE system_settings SET logo_path = ? WHERE id = 1', [`logo.${ext}`]);
    } catch (err) {
      this.logger.warn(`logo install failed, continuing: ${(err as Error).message}`);
      return false;
    }
    return true;
  }
}
