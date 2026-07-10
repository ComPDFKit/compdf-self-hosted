/**
 * AuthModule — admin auth (JWT session + bcrypt + login-failure
 * rate-limit via Redis). ComPDF Web does not import this module's guard.
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ApiKeyService } from './api-key.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ClientsModule } from '../clients/clients.module';

/**
 * AuthModule — admin auth (JWT session + bcrypt + login-failure
 * rate-limit via Redis) + client API key guard/service.
 *
 * MysqlClient / RedisClient come from the shared ClientsModule (single
 * ownership) — no local duplicate providers.
 */
@Module({
  imports: [
    ClientsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret') ?? 'change-me-in-prod',
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, ApiKeyService, JwtAuthGuard, ApiKeyGuard],
  exports: [AuthService, ApiKeyService, JwtAuthGuard, ApiKeyGuard, JwtModule],
})
export class AuthModule {}
