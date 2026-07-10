/**
 * LicenseModule — READ-ONLY / DISPLAY-ONLY license surface + admin token upload.
 *
 * Exposes:
 *   - LicenseTokenService (provided + exported) so SpaController and
 *     LicenseController can read the display payload.
 *   - LicenseController:
 *       GET  /api/v1/license         → decodeForDisplay()  (public, display-only)
 *       POST /api/v1/license/upload  → write a new license.jwt, return display
 *                                      payload (JwtAuthGuard-protected — admin only).
 *
 * AuthModule is imported so JwtAuthGuard is DI-resolvable on the upload route;
 * ClientsModule supplies MysqlClient for that guard in this module context.
 * No limit fields, no enforcement — the server never interprets the signed
 * token (architecture §5).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientsModule } from '../clients/clients.module';
import { LicenseTokenService } from './license-token.service';
import { LicenseController } from './license.controller';

@Module({
  imports: [AuthModule, ClientsModule],
  controllers: [LicenseController],
  providers: [LicenseTokenService],
  exports: [LicenseTokenService],
})
export class LicenseModule {}
