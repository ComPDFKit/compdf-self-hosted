/**
 * ConversionModule — `/api/v1/process/*` pass-through to the conversion engine
 * via ConversionService (which parses the forward-compat truncation headers).
 *
 * ConversionService wraps ConversionClient (provided by ClientsModule). Multer
 * memory storage + 100 MB limit. Routes are behind ApiKeyGuard (the ComPDF Web
 * SPA sends the deployment's x-api-key, auto-injected by the server).
 */
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import multer from 'multer';
import { ClientsModule } from '../clients/clients.module';
import { AuthModule } from '../auth/auth.module';
import { ConversionController } from './conversion.controller';
import { ConversionService } from './conversion.service';

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
  controllers: [ConversionController],
  providers: [ConversionService],
  // Exported so TaskModule (which imports ConversionModule) can inject
  // ConversionService into TaskService for async conversion ops.
  exports: [ConversionService],
})
export class ConversionModule {}
