/**
 * LicenseModule — READ-ONLY / DISPLAY-ONLY license surface + admin token upload.
 *
 * Exposes:
 *   - LicenseTokenService (provided + exported) so the global
 *     LicensePassthroughInterceptor (APP_INTERCEPTOR in AppModule) and the
 *     SpaController can read the display payload.
 *   - LicenseController:
 *       GET  /api/v1/license         → decodeForDisplay()  (public, display-only)
 *       POST /api/v1/license/upload  → write a new license.jwt, return display
 *                                      payload (JwtAuthGuard-protected — admin only).
 *
 * AuthModule is imported so JwtAuthGuard is DI-resolvable on the upload route.
 * No limit fields, no enforcement — the server never interprets the signed
 * token (architecture §5).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LicenseTokenService } from './license-token.service';
import { LicenseController } from './license.controller';

@Module({
  imports: [AuthModule],
  controllers: [LicenseController],
  providers: [LicenseTokenService],
  exports: [LicenseTokenService],
})
export class LicenseModule {}
