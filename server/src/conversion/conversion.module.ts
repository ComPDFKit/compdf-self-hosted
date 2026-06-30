/**
 * ConversionModule — `/api/v1/conversion/*` pass-through to the conversion engine
 * via ConversionService (which parses the forward-compat truncation headers).
 *
 * ConversionService wraps ConversionClient (provided by ClientsModule). Multer
 * memory storage + 100 MB limit. ComPDF Web routes — NOT behind JwtAuthGuard.
 */
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import multer from 'multer';
import { ClientsModule } from '../clients/clients.module';
import { ConversionController } from './conversion.controller';
import { ConversionService } from './conversion.service';

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

@Module({
  imports: [
    ClientsModule,
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
