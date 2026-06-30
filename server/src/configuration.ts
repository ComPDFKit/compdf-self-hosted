import { join } from 'path';

export default () => {
  const conversionBaseUrl = process.env.COMPDF_SDK_BASE_URL ?? 'http://compdf-app:7000';
  const pdfSdkBaseUrl = process.env.PDF_SDK_BASE_URL ?? (
    process.env.COMPDF_SDK_BASE_URL ? conversionBaseUrl : 'http://compdf-app:7001'
  );

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
    sdk: { baseUrl: conversionBaseUrl },
    pdfSdk: { baseUrl: pdfSdkBaseUrl },
    conversion: { baseUrl: process.env.CONVERSION_BASE_URL ?? conversionBaseUrl },
    license: {
      tokenPath: process.env.LICENSE_TOKEN_PATH ?? '/configs/license.jwt',
      rawToken: process.env.LICENSE_KEY ?? '',
    },
    jwt: { secret: process.env.JWT_SECRET ?? 'change-me-in-prod' },
    publicDir: process.env.PUBLIC_DIR ?? join(process.cwd(), 'public'),
    settings: { path: process.env.SETTINGS_PATH ?? join(process.cwd(), 'configs/settings.yml') },
    storageDir: process.env.STORAGE_DIR ?? join(process.cwd(), 'storage'),
  };
};
