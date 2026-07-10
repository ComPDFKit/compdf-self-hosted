/**
 * SpaModule — serves both SPAs (ComPDF Web + Dashboard) with display-only
 * license, brand-config, and API-key injection. Imports LicenseModule for
 * LicenseTokenService, DashboardModule for BrandSettingsService, and
 * AuthModule for ApiKeyService (deployment key plaintext for the Web SPA).
 */
import { Module } from '@nestjs/common';
import { LicenseModule } from '../license/license.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AuthModule } from '../auth/auth.module';
import { SpaController } from './spa.controller';

@Module({
  imports: [LicenseModule, DashboardModule, AuthModule],
  controllers: [SpaController],
})
export class SpaModule {}
