/**
 * AuthController — admin authentication.
 *   POST /api/v1/auth/login          (public: bcrypt verify + issue JWT)
 *   POST /api/v1/auth/change-password (JwtAuthGuard: first-login forced change)
 *
 * ComPDF Web routes are NOT mounted behind JwtAuthGuard.
 */
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, MinLength, MaxLength } from 'class-validator';
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
  @IsString() @MinLength(6) @MaxLength(128)
  newPassword!: string;
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto.username, dto.password);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: AdminPayload }): Promise<{ ok: true }> {
    await this.auth.changePassword(req.user.sub, dto.oldPassword, dto.newPassword);
    return { ok: true };
  }
}
