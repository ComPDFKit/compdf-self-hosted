/**
 * TaskModule — async task lifecycle (/api/v1/task/*).
 *
 * Imports:
 *   - ClientsModule    → MysqlClient, PdfSdkClient
 *   - LicenseModule    → LicenseTokenService
 *   - ConversionModule → ConversionService (TaskService.dispatch routes
 *     conversion ops through it; it must be exported by ConversionModule)
 *   - AuthModule       → ApiKeyGuard (mounted on TaskController)
 *
 * ConfigService is global (ConfigModule isGlobal in AppModule), so it is
 * available to TaskService without an explicit import here.
 *
 * TaskService is a plain provider; NestJS resolves its constructor deps by
 * type. The controller owns the HTTP envelope shape; the service owns the
 * background run + on-disk result file.
 */
import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { LicenseModule } from '../license/license.module';
import { ConversionModule } from '../conversion/conversion.module';
import { AuthModule } from '../auth/auth.module';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';

@Module({
  imports: [ClientsModule, LicenseModule, ConversionModule, AuthModule],
  controllers: [TaskController],
  providers: [TaskService],
})
export class TaskModule {}
