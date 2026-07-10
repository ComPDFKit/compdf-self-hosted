/**
 * LicenseTokenService — license token storage + display decoding.
 *
 * The server NEVER interprets, validates, or enforces license limits. This
 * service only reads the configured token and decodes the payload for display
 * in the ComPDF Web — without verifying the signature.
 *
 * No limit fields here. No watermark/concurrency/page logic. Ever.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface LicenseDisplay {
  sub?: string;
  exp?: number;
  scope?: unknown;
  limits?: unknown;
  status: 'valid' | 'expiring' | 'expired' | 'inactive';
  /** Whether a usable token is configured at all. */
  present: boolean;
}

/** A token within this many seconds of expiry is flagged "expiring". */
const EXPIRING_WINDOW_SECONDS = 7 * 24 * 60 * 60; // 7 days

@Injectable()
export class LicenseTokenService {
  private readonly logger = new Logger(LicenseTokenService.name);
  private readonly tokenPath: string;
  private readonly rawTokenEnv: string;

  // File-read cache (1s mtime TTL) so a hot-swapped license.jwt is picked up
  // without re-reading the file on every upstream call.
  private cachedFileToken: string | null = null;
  private cachedFileMtimeMs = 0;
  private cachedAtMs = 0;
  private static readonly CACHE_TTL_MS = 1000;

  constructor(private readonly config: ConfigService) {
    this.tokenPath = this.config.get<string>('license.tokenPath') ?? '/configs/license.jwt';
    this.rawTokenEnv = this.config.get<string>('license.rawToken') ?? '';
  }

  /**
   * The raw signed JWT.
   * Priority: env `LICENSE_KEY` (license.rawToken) → file at license.tokenPath.
   * Returns '' when neither is available (upstream will 402; that is by design).
   */
  getRawToken(): string {
    if (this.rawTokenEnv && this.rawTokenEnv.trim()) {
      return this.rawTokenEnv.trim();
    }
    return this.readFileToken();
  }

  /**
   * Decode the JWT payload (NO signature verification) for UI display.
   * `status` is inferred from `exp` only — never from any limit field.
   * Tolerates malformed/placeholder tokens (returns status 'inactive').
   */
  decodeForDisplay(): LicenseDisplay {
    const token = this.getRawToken();
    if (!token) {
      return { status: 'inactive', present: false };
    }
    const payload = this.decodePayload(token);
    if (!payload) {
      return { status: 'inactive', present: true };
    }
    const now = Math.floor(Date.now() / 1000);
    const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
    let status: LicenseDisplay['status'] = 'inactive';
    if (exp !== undefined) {
      if (exp <= 0) status = 'expired'; // placeholder token (exp:0)
      else if (exp <= now) status = 'expired';
      else if (exp - now <= EXPIRING_WINDOW_SECONDS) status = 'expiring';
      else status = 'valid';
    }
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
      exp,
      scope: payload.scope,
      limits: payload.limits,
      status,
      present: true,
    };
  }

  private decodePayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
      // JWT base64url payload — pad and decode
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = Buffer.from(padded, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch (err) {
      this.logger.warn(`failed to decode license payload: ${(err as Error).message}`);
      return null;
    }
  }

  private readFileToken(): string {
    try {
      const mtimeMs = statSync(this.tokenPath).mtimeMs;
      const now = Date.now();
      if (
        this.cachedFileToken !== null &&
        mtimeMs === this.cachedFileMtimeMs &&
        now - this.cachedAtMs < LicenseTokenService.CACHE_TTL_MS
      ) {
        return this.cachedFileToken;
      }
      const token = readFileSync(this.tokenPath, 'utf8').trim();
      this.cachedFileToken = token;
      this.cachedFileMtimeMs = mtimeMs;
      this.cachedAtMs = now;
      return token;
    } catch (err) {
      this.logger.debug(`license token file unreadable (${this.tokenPath}): ${(err as Error).message}`);
      return '';
    }
  }

  /** Resolve a relative token path against CWD (helper for license upload). */
  resolveTokenPath(): string {
    if (this.tokenPath.startsWith('/')) return this.tokenPath;
    return join(process.cwd(), this.tokenPath);
  }

  /** Clear the file-read cache (called after an online token upload). */
  invalidateCache(): void {
    this.cachedFileToken = null;
    this.cachedFileMtimeMs = 0;
    this.cachedAtMs = 0;
  }
}
