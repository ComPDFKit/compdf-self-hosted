/**
 * UpdateCheckService — checks a remote manifest for new self-hosted releases
 * (PRD §6.2.7 版本信息: 最新版本检测). Notification-only: the operator pulls a
 * new Docker image manually; this service never auto-updates anything.
 *
 * Flow:
 *   1. Read `updates.check_url` + `updates.enabled` from SettingsFileSyncService
 *      (sourced from settings.yml at startup).
 *   2. If disabled / no URL → return { latest: null, updateAvailable: false }.
 *   3. Fetch the manifest JSON (10s timeout). Cache in Redis 6h under
 *      `update:manifest` to avoid hammering the endpoint on every dashboard load.
 *   4. semver-compare `current` (package.json) vs `latest` (manifest).
 *
 * Resilience: a fetch/parse failure is logged + swallowed — getVersion() returns
 * latest=null so the dashboard shows "unable to check" rather than crashing.
 */
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { RedisClient } from '../clients/redis.client';
import { SettingsFileSyncService } from './settings-file-sync.service';

export interface UpdateManifest {
  version: string;
  releasedAt?: string;
  changelogUrl?: string;
  image?: string;
  minUpgradeFrom?: string;
}

export interface VersionStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releasedAt: string | null;
  changelogUrl: string | null;
  image: string | null;
}

const CACHE_KEY = 'update:manifest';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6h

@Injectable()
export class UpdateCheckService {
  private readonly logger = new Logger(UpdateCheckService.name);
  private readonly http: AxiosInstance;

  constructor(
    private readonly redis: RedisClient,
    private readonly settingsSync: SettingsFileSyncService,
  ) {
    this.http = axios.create({ timeout: 10_000 });
  }

  async getStatus(currentVersion: string): Promise<VersionStatus> {
    const { enabled, checkUrl } = this.settingsSync.getUpdatesConfig();
    if (!enabled || !checkUrl) {
      return emptyStatus(currentVersion);
    }

    const manifest = await this.fetchManifest(checkUrl);
    if (!manifest) {
      return emptyStatus(currentVersion);
    }

    const updateAvailable = compareSemver(manifest.version, currentVersion) > 0;
    return {
      current: currentVersion,
      latest: manifest.version,
      updateAvailable,
      releasedAt: manifest.releasedAt ?? null,
      changelogUrl: manifest.changelogUrl ?? null,
      image: manifest.image ?? null,
    };
  }

  private async fetchManifest(url: string): Promise<UpdateManifest | null> {
    // Try Redis cache first.
    try {
      const cached = await this.redis.get(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as UpdateManifest;
        if (parsed && typeof parsed.version === 'string') return parsed;
      }
    } catch {
      // corrupt cache — fall through to fetch
    }

    try {
      const res = await this.http.get<UpdateManifest>(url);
      const manifest = res.data;
      if (!manifest || typeof manifest.version !== 'string') {
        this.logger.warn(`update manifest at ${url} has no version field`);
        return null;
      }
      try {
        await this.redis.set(CACHE_KEY, JSON.stringify(manifest), CACHE_TTL_SECONDS);
      } catch (err) {
        this.logger.debug(`update manifest cache write failed: ${(err as Error).message}`);
      }
      return manifest;
    } catch (err) {
      this.logger.warn(`update manifest fetch failed from ${url}: ${(err as Error).message}`);
      return null;
    }
  }
}

function emptyStatus(current: string): VersionStatus {
  return {
    current,
    latest: null,
    updateAvailable: false,
    releasedAt: null,
    changelogUrl: null,
    image: null,
  };
}

/**
 * Compare two semver-ish strings ("4.1.0" vs "4.2.0"). Returns >0 if a > b,
 * 0 if equal, <0 if a < b. Non-numeric segments are compared as 0. Tolerates
 * pre-release suffixes by ignoring them (strips everything after the first non
 * [0-9.] character run).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(v: string): number[] {
  const clean = (v ?? '').replace(/^[^0-9]*/, '').split(/[^0-9.]/)[0];
  return clean.split('.').map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
}
