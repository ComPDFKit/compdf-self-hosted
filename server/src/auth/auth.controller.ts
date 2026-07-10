/**
 * AuthController — admin authentication.
 *   POST /api/v1/auth/login          (public: bcrypt verify + issue JWT)
 *   POST /api/v1/auth/change-password (JwtAuthGuard: first-login forced change)
 *
 * ComPDF Web routes are NOT mounted behind JwtAuthGuard.
 */
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import type { Request } from 'express';
import { AuthService, LoginResult } from './auth.service';
import { JwtAuthGuard, AdminPayload } from './guards/jwt-auth.guard';

class LoginDto {
  @IsString() @MinLength(1) @MaxLength(50)
  username!: string;
  @IsString() @MinLength(1) @MaxLength(128)
  password!: string;
}

class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(128)
  oldPassword!: string;
  // PRD §6 账号管理: 8-64 chars, must contain letters AND numbers.
  @IsString() @MinLength(8) @MaxLength(64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/, { message: 'password must be 8-64 chars with letters and numbers' })
  newPassword!: string;
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResult> {
    return this.auth.login(dto.username, dto.password, {
      ip: clientIp(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: AdminPayload }): Promise<{ ok: true }> {
    await this.auth.changePassword(req.user.sub, dto.oldPassword, dto.newPassword);
    return { ok: true };
  }

  /** Public: whether the login page should show the built-in admin hint. */
  @Get('setup-status')
  setupStatus() {
    return this.auth.getSetupStatus();
  }
}

/** Extract the client IP, honoring x-forwarded-for when behind a proxy. */
function clientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim().slice(0, 45) || null;
  }
  return typeof req.ip === 'string' ? req.ip.slice(0, 45) : null;
}
