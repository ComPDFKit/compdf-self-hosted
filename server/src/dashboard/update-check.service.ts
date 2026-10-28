/**
 * Lightweight Dashboard notifications from the same GitHub channel manifest
 * used by the updater. The updater independently verifies the detached signature
 * before accepting any download or installation. Unknown/failed checks remain
 * unknown; only a successfully fetched active release confirms the latest version.
 */
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { createHash } from 'crypto';
import { RedisClient } from '../clients/redis.client';
import { SettingsFileSyncService } from './settings-file-sync.service';

export interface UpdateManifest {
  version: string;
  releasedAt?: string;
  changelogUrl?: string;
  image?: string;
  minUpgradeFrom?: string;
  releaseNotes?: string;
  status?: string;
  expiresAt?: string;
  images?: { server?: { name: string; tag: string; digest: string } };
}

export interface VersionStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releasedAt: string | null;
  changelogUrl: string | null;
  image: string | null;
  releaseNotes: string | null;
}

const CACHE_TTL_SECONDS = 5 * 60;

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
      image: manifest.image ?? (manifest.images?.server
        ? `${manifest.images.server.name}:${manifest.images.server.tag}@${manifest.images.server.digest}`
        : null),
      releaseNotes: manifest.releaseNotes ?? null,
    };
  }

  private async fetchManifest(url: string): Promise<UpdateManifest | null> {
    // A source change must not reuse another feed's cached test or release data.
    const cacheKey = `update:manifest:v2:${createHash('sha256').update(url).digest('hex')}`;
    // Try Redis cache first.
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as UpdateManifest;
        if (isActiveManifest(parsed)) return parsed;
      }
    } catch {
      // corrupt cache — fall through to fetch
    }

    try {
      const res = await this.http.get<UpdateManifest>(url);
      const manifest = res.data;
      if (!isActiveManifest(manifest)) {
        this.logger.warn(`update manifest at ${url} is invalid, inactive, or expired`);
        return null;
      }
      try {
        await this.redis.set(cacheKey, JSON.stringify(manifest), CACHE_TTL_SECONDS);
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

function isActiveManifest(value: unknown): value is UpdateManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as UpdateManifest;
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) return false;
  if (manifest.status && manifest.status !== 'active') return false;
  if (manifest.expiresAt && !(Date.parse(manifest.expiresAt) > Date.now())) return false;
  return true;
}

function emptyStatus(current: string): VersionStatus {
  return {
    current,
    latest: null,
    updateAvailable: false,
    releasedAt: null,
    changelogUrl: null,
    image: null,
    releaseNotes: null,
  };
}

/**
 * Compare two semver-ish strings ("1.1.0" vs "1.2.0"). Returns >0 if a > b,
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
