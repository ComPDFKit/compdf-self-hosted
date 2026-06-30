/**
 * SpaModule — serves the ComPDF Web SPA with display-only license
 * injection. Imports LicenseModule for LicenseTokenService (display payload).
 */
import { Module } from '@nestjs/common';
import { LicenseModule } from '../license/license.module';
import { SpaController } from './spa.controller';

@Module({
  imports: [LicenseModule],
  controllers: [SpaController],
})
export class SpaModule {}
