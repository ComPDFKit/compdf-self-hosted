import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientsModule } from '../clients/clients.module';
import { ConversionModule } from '../conversion/conversion.module';
import { BatchController } from './batch.controller';
import { BatchCleanup } from './batch.cleanup';
import { BatchService } from './batch.service';
import { BatchWorker } from './batch.worker';

@Module({
  imports: [ClientsModule, ConversionModule, AuthModule],
  controllers: [BatchController],
  providers: [BatchService, BatchWorker, BatchCleanup],
  exports: [BatchService],
})
export class BatchModule {}
