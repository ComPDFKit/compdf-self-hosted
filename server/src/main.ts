/**
 * main.ts — ComPDF self-hosted server bootstrap.
 *
 * Cross-cutting globals (ValidationPipe / AllExceptionsFilter / the two
 * interceptors) are registered as APP_* providers in AppModule, so this file
 * only: enables CORS (permissive for the SPA origin), and listens on
 * configuration.port (8080). No global prefix — routes are already prefixed
 * `api/v1`, and the SPA owns `/`.
 */
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import express from 'express';
import { join } from 'path';
import { AppModule } from './app.module';
import { SystemLogService } from './dashboard/system-log.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // CORS: permissive by default (origin: true). If CORS_ORIGINS is set to a
  // comma-separated list, restrict to those exact origins.
  const origins = config.get<string[]>('cors.origins') ?? ['*'];
  const permissive = origins.length === 0 || origins.includes('*');
  app.enableCors({
    origin: permissive ? true : origins,
    credentials: true,
    exposedHeaders: [
      'Content-Disposition',
      'Content-Type',
      'X-ComPDF-Truncated',
      'X-ComPDF-Pages-Processed',
      'X-ComPDF-Pages-Total',
    ],
  });

  // Enable graceful shutdown so OnModuleDestroy fires on SIGTERM/SIGINT (Docker
  // stop → service_stopped system log).
  app.enableShutdownHooks();

  const port = config.get<number>('port') ?? 8080;
  const publicDir = config.get<string>('publicDir') ?? join(process.cwd(), 'public');

  configureWebStaticAssets(app, publicDir);

  // Capture non-API system-level faults as error logs (best-effort DB write).
  const systemLog = app.get(SystemLogService);
  const faultLogger = new Logger('SystemFault');
  process.on('uncaughtException', (err: Error) => {
    faultLogger.error(`uncaughtException: ${err.message}\n${err.stack ?? ''}`);
    void systemLog.recordError('uncaught_exception', err.message, { stack: err.stack ?? null });
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack ?? null : null;
    faultLogger.error(`unhandledRejection: ${msg}`);
    void systemLog.recordError('unhandled_rejection', msg, { stack });
  });

  await app.listen(port);
  new Logger('Bootstrap').log(`ComPDF server listening on http://0.0.0.0:${port}`);
}

export function configureWebStaticAssets(
  app: Pick<INestApplication, 'use'>,
  publicDir: string,
): void {
  const webDist = join(publicDir, 'compdf-web');
  // The production image contains one unified Web UI app at public/compdf-web.
  // Mount it unconditionally so frontend assets load for both the public Web demo
  // and Dashboard routes. SpaController serves the same SPA index for /,
  // /pdf-tools/*, and /admin/*.
  app.use(express.static(webDist, { index: false }));
  // Backward-compatible asset path for deployments or cached HTML that request
  // /admin/assets/* from the former dashboard base. index:false lets /admin/*
  // history routes fall through to SpaController.
  app.use('/admin', express.static(webDist, { index: false }));
}

if (require.main === module) {
  void bootstrap();
}
