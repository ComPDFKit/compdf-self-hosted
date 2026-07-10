/**
 * ApiKeyService — read-only access to the deployment's API key plaintext, used
 * to auto-inject into the ComPDF Web SPA (window.COMPDF_CONFIG.apiKey) so the
 * ComPDF Web can call the sync PDF/conversion routes without a manual key
 * entry step (nutrient-style auto-provisioning, but server-injected).
 *
 * Source priority:
 *   1. `API_KEY` env var (operator-provisioned) — wins if set.
 *   2. `<storageDir>/.api-key-plaintext` — written once by init-db.ts when it
 *      generates a random key on first boot. Mode 0600. The file persists
 *      across restarts so the server can re-inject on boot.
 *   3. null — no plaintext available; the SPA shows "API Key 为空或错误" on
 *      the first tool call (401 from ApiKeyGuard). init-db does not create a
 *      second key when an active API key already exists.
 *
 * The plaintext is ONLY the deployment's own client key (single-tenant,
 * self-hosted). It is never the license token, never an admin credential. The
 * admin can rotate the key from the Dashboard (future) or by setting API_KEY
 * env + restarting.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { join } from 'path';

const PLAINTEXT_FILENAME = '.api-key-plaintext';

@Injectable()
export class ApiKeyService {
  private readonly plaintextPath: string;
  private cached: string | null | undefined;

  constructor(private readonly config: ConfigService) {
    const storageDir = this.config.get<string>('storageDir') ?? join(process.cwd(), 'storage');
    this.plaintextPath = join(storageDir, PLAINTEXT_FILENAME);
  }

  /**
   * Return the deployment API key plaintext, or null if unavailable. Cached
   * for the process lifetime (the key only changes on restart).
   */
  getPlaintextKey(): string | null {
    if (this.cached !== undefined) return this.cached;
    const env = (process.env.API_KEY ?? '').trim();
    if (env) {
      this.cached = env;
      return env;
    }
    try {
      const raw = readFileSync(this.plaintextPath, 'utf8').trim();
      this.cached = raw || null;
      return this.cached;
    } catch {
      this.cached = null;
      return null;
    }
  }
}
