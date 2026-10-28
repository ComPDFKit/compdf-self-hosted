import { Body, Controller, Get, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { AdminPayload, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LicenseUpdateService } from './license-update.service';

@Controller('api/v1/dashboard/license')
@UseGuards(JwtAuthGuard)
export class LicenseUpdateController {
  constructor(private readonly licenses: LicenseUpdateService) {}

  @Get('update')
  status() { return this.licenses.status(); }

  @Post('update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 65536, files: 1, fields: 1 } }))
  update(@UploadedFile() file: Express.Multer.File | undefined, @Body('approve') approve: string, @Req() req: Request & { user: AdminPayload }) {
    return this.licenses.start(file, approve, req.user.username);
  }

  @Post('recover')
  recover(@Req() req: Request & { user: AdminPayload }) { return this.licenses.recover(req.user.username); }
}
