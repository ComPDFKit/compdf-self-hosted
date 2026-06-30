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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Permissive CORS: the ComPDF Web SPA is served from this same
  // origin (:8080), but allow other origins (e.g. a dev Vite server) too.
  app.enableCors({
    origin: true,
    credentials: true,
    exposedHeaders: [
      'Content-Disposition',
      'Content-Type',
      'X-ComPDF-Truncated',
      'X-ComPDF-Pages-Processed',
      'X-ComPDF-Pages-Total',
    ],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('port') ?? 8080;
  const publicDir = config.get<string>('publicDir') ?? join(process.cwd(), 'public');

  configureWebStaticAssets(app, publicDir);

  await app.listen(port);
  new Logger('Bootstrap').log(`ComPDF server listening on http://0.0.0.0:${port}`);
}

export function configureWebStaticAssets(app: Pick<INestApplication, 'use'>, publicDir: string): void {
  app.use(express.static(join(publicDir, 'compdf-web'), { index: false }));
}

if (require.main === module) {
  void bootstrap();
}
