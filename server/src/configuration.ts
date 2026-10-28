import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export default () => {
  const conversionBaseUrl = process.env.CONVERSION_BASE_URL ?? 'http://compdf-app:7000';
  const pdfSdkBaseUrl = process.env.PDF_SDK_BASE_URL ?? 'http://compdf-app:7001';
  const storageDir = process.env.STORAGE_DIR ?? join(process.cwd(), 'storage');

  return {
    port: parseInt(process.env.PORT ?? '8080', 10),
    database: {
      host: process.env.DATABASE_HOST ?? 'compdf-infra',
      port: parseInt(process.env.DATABASE_PORT ?? '3306', 10),
      user: process.env.DATABASE_USER ?? 'compdfkit',
      password: process.env.DATABASE_PASSWORD ?? 'compdfkit-pass-2026',
      name: process.env.DATABASE_NAME ?? 'compdfkit',
    },
    redis: {
      host: process.env.REDIS_HOST ?? 'compdf-infra',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    },
    pdfSdk: { baseUrl: pdfSdkBaseUrl },
    conversion: { baseUrl: conversionBaseUrl },
    license: {
      tokenPath: process.env.LICENSE_TOKEN_PATH ?? '/configs/license.jwt',
      rawToken: process.env.LICENSE_KEY ?? '',
    },
    jwt: { secret: resolveJwtSecret(storageDir, process.env.JWT_SECRET) },
    publicDir: process.env.PUBLIC_DIR ?? join(process.cwd(), 'public'),
    settings: { path: process.env.SETTINGS_PATH ?? join(process.cwd(), 'configs/settings.yml') },
    storageDir,
    mcp: {
      enabled: process.env.MCP_ENABLED?.trim().toLowerCase() !== 'false',
      publicUrl: process.env.MCP_PUBLIC_URL?.trim() || '',
      allowedHosts: (process.env.MCP_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      maxInlineFileBytes: Math.min(parsePositiveInt(process.env.MCP_MAX_INLINE_FILE_BYTES, 4 * 1024 * 1024), 4 * 1024 * 1024),
    },
    batch: {
      maxFileBytes: parsePositiveInt(process.env.BATCH_MAX_FILE_BYTES, 100 * 1024 * 1024),
      maxFiles: parsePositiveInt(process.env.BATCH_MAX_FILES, 100),
      maxTotalBytes: parsePositiveInt(process.env.BATCH_MAX_TOTAL_BYTES, 1024 * 1024 * 1024),
      retentionDays: parsePositiveInt(process.env.BATCH_RETENTION_DAYS, 7),
      workerPollMs: parsePositiveInt(process.env.BATCH_WORKER_POLL_MS, 1000),
    },
    updater: {
      socketPath: process.env.COMPDF_UPDATER_SOCKET ?? '/run/compdf-updater/compdf-updater.sock',
    },
    cors: {
      // '*' (default) = permissive, current behavior. Comma-separated list to restrict.
      origins: (process.env.CORS_ORIGINS ?? '*')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    },
    // Legacy/public config flag injected into the SPA. Route serving is handled
    // by SpaController and remains available for /, /pdf-tools/*, and /admin/*.
    compdfTools: {
      enabled: process.env.COMPDF_TOOLS_ENABLED?.trim().toLowerCase() !== 'false',
    },
  };
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const JWT_SECRET_FILE = '.dashboard-jwt-secret';
const SERVER_INSTANCE_FILE = '.dashboard-server-instance';

/**
 * Keep the generated Dashboard JWT secret across a Docker restart, but rotate
 * it when Docker creates a replacement server container. Docker preserves a
 * container's hostname on restart and assigns a new one on recreation.
 */
export function resolveJwtSecret(storageDir: string, configuredSecret?: string, instanceId = process.env.HOSTNAME): string {
  if (configuredSecret?.trim()) return configuredSecret.trim();

  const newSecret = () => randomBytes(32).toString('hex');
  const secretPath = join(storageDir, JWT_SECRET_FILE);
  const instancePath = join(storageDir, SERVER_INSTANCE_FILE);
  try {
    mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    const previousSecret = existsSync(secretPath) ? readFileSync(secretPath, 'utf8').trim() : '';
    const currentInstance = instanceId?.trim() ?? '';
    const previousInstance = existsSync(instancePath) ? readFileSync(instancePath, 'utf8').trim() : '';
    const isReplacementContainer = currentInstance.length > 0 && previousInstance.length > 0 && currentInstance !== previousInstance;
    const secret = previousSecret && !isReplacementContainer ? previousSecret : newSecret();

    if (secret !== previousSecret) writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
    if (currentInstance && currentInstance !== previousInstance) writeFileSync(instancePath, `${currentInstance}\n`, { mode: 0o600 });
    return secret;
  } catch {
    // Storage is expected to be writable in container deployments. If it is
    // not, prefer a secure ephemeral secret over a fixed fallback secret.
    return newSecret();
  }
}
