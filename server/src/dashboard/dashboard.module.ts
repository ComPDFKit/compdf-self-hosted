/**
 * DashboardModule — admin Dashboard API + public brand assets.
 *
 * Controllers:
 *   - DashboardController (api/v1/dashboard/*, JwtAuthGuard): overview, logs
 *     (+detail+CSV export), login-records, api-keys, version, account
 *     (username), settings (+logo upload).
 *   - BrandingController (api/v1/dashboard/branding/*, PUBLIC): logo stream.
 *
 * BrandSettingsService is EXPORTED so SpaModule can inject it to build the
 * window.COMPDF_CONFIG payload injected into both SPAs' index.html.
 *
 * Imports:
 *   - ClientsModule → MysqlClient
 *   - AuthModule    → JwtAuthGuard (mounted on DashboardController)
 *
 * ConfigService is global (ConfigModule isGlobal in AppModule).
 */
import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { AuthModule } from '../auth/auth.module';
import { BrandSettingsService } from './brand-settings.service';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { BrandingController } from './branding.controller';
import { SettingsFileSyncService } from './settings-file-sync.service';
import { SystemLogService } from './system-log.service';
import { UpdateCheckService } from './update-check.service';

@Module({
  imports: [ClientsModule, AuthModule],
  controllers: [DashboardController, BrandingController],
  providers: [DashboardService, BrandSettingsService, SettingsFileSyncService, SystemLogService, UpdateCheckService],
  exports: [BrandSettingsService],
})
export class DashboardModule {}
