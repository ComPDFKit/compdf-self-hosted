import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BatchModule } from '../batch/batch.module';
import { ClientsModule } from '../clients/clients.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { McpAdminController, McpController, McpStatusController } from './mcp.controller';
import { McpStatusService } from './mcp-status.service';
import { McpSettings } from './mcp.settings';
import { McpTools } from './mcp.tools';

@Module({
  imports: [AuthModule, BatchModule, ClientsModule, RuntimeModule],
  controllers: [McpController, McpAdminController, McpStatusController],
  providers: [McpSettings, McpTools, McpStatusService],
  exports: [McpSettings],
})
export class McpModule {}
