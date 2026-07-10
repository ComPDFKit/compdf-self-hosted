/**
 * LicenseController — display-only license info + online token upload.
 *
 *   GET  /api/v1/license         → LicenseTokenService.decodeForDisplay()
 *   POST /api/v1/license/upload  → write a new license.jwt, return display payload
 *
 * The GET route returns the decoded (NON-verified) payload for compdf-web
 * display: sub/exp/scope/limits/status/present. This is display-only — it carries
 * NO limit toggles and NOT the raw token.
 *
 * The POST `/upload` route writes the uploaded bytes VERBATIM to the token path
 * (resolveTokenPath()), invalidates the service's file cache, and returns the new
 * display payload. The server NEVER validates the JWT signature — the closed-source
 * app verifies on the next upstream call (architecture §5/§8.1). No limit fields,
 * no enforcement, ever.
 */
import { BadRequestException, Controller, Get, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { writeFileSync } from 'fs';
import { LicenseTokenService, LicenseDisplay } from './license-token.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('api/v1/license')
export class LicenseController {
  constructor(private readonly licenseToken: LicenseTokenService) {}

  @Get()
  display(): LicenseDisplay {
    return this.licenseToken.decodeForDisplay();
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 64 * 1024 } }))
  async upload(@UploadedFile() file: Express.Multer.File | undefined): Promise<LicenseDisplay> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'license token file is required' });
    }
    // Write the raw token verbatim. The server never validates the JWT —
    // the closed-source app verifies the signature on the next upstream call.
    writeFileSync(this.licenseToken.resolveTokenPath(), file.buffer);
    this.licenseToken.invalidateCache();
    return this.licenseToken.decodeForDisplay();
  }
}
