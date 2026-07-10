/**
 * PdfModule — `/api/v1/process/pdf/*` pass-through to the PDF SDK.
 *
 * Multer is configured with memory storage (files are forwarded to upstream as
 * buffers) and a 100 MB per-file limit. Routes are behind ApiKeyGuard (the
 * ComPDF Web SPA sends the deployment's x-api-key, auto-injected by the server).
 */
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import multer from 'multer';
import { ClientsModule } from '../clients/clients.module';
import { AuthModule } from '../auth/auth.module';
import { PdfSdkClient } from '../clients/pdf-sdk.client';
import { PdfController } from './pdf.controller';

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

@Module({
  imports: [
    ClientsModule,
    AuthModule,
    MulterModule.register({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES },
    }),
  ],
  controllers: [PdfController],
})
export class PdfModule {}
