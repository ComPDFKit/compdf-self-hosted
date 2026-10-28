import { Global, Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { ProcessingRequestGuard } from './processing-request.guard';
import { RuntimeModeService } from './runtime-mode.service';
import { TaskDrainService } from './task-drain.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ProcessingActivityInterceptor } from './processing-activity.interceptor';

@Global()
@Module({
  imports: [ClientsModule],
  providers: [RuntimeModeService, ProcessingRequestGuard, TaskDrainService, { provide: APP_INTERCEPTOR, useClass: ProcessingActivityInterceptor }],
  exports: [RuntimeModeService, ProcessingRequestGuard, TaskDrainService],
})
export class RuntimeModule {}
