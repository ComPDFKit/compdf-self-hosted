/**
 * TaskModule — async task lifecycle (/api/v1/task/*).
 *
 * Imports:
 *   - ClientsModule    → MysqlClient, PdfSdkClient
 *   - ConversionModule → ConversionService (TaskService.dispatch routes
 *     conversion ops through it; it must be exported by ConversionModule)
 *   - AuthModule       → ApiKeyGuard (mounted on TaskController)
 *
 * ConfigService is global (ConfigModule isGlobal in AppModule), so it is
 * available to TaskService without an explicit import here.
 *
 * TaskService is a plain provider; the DI container resolves its constructor deps by
 * type. The controller returns raw data on success (the global
 * EnvelopeInterceptor wraps it as `{ code, msg, data }`); errors throw to
 * AllExceptionsFilter which shapes `{ code, msg, data: null }`. The service
 * owns the background run + on-disk result file.
 */
import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { ConversionModule } from '../conversion/conversion.module';
import { AuthModule } from '../auth/auth.module';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';

@Module({
  imports: [ClientsModule, ConversionModule, AuthModule],
  controllers: [TaskController],
  providers: [TaskService],
})
export class TaskModule {}
