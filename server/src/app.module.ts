/**
 * AppModule — assembles the ComPDF self-hosted server.
 *
 * Global cross-cutting concerns are registered here via APP_* tokens (preferred
 * over useGlobal* in main.ts — cleaner and DI-testable):
 *   - APP_PIPE:           ValidationPipe (whitelist + transform)
 *   - APP_FILTER:         AllExceptionsFilter (normalizes BOTH upstream dialects)
 *   - APP_INTERCEPTOR:    LoggingInterceptor (writes operation_logs)
 *                          then EnvelopeInterceptor (wraps JSON success in {code,msg,data})
 *
 * ConfigModule is global so every client/service can read ConfigService. The
 * four egress/infra clients live in the shared ClientsModule (single ownership).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import configuration from './configuration';
import { ClientsModule } from './clients/clients.module';
import { LicenseModule } from './license/license.module';
import { AuthModule } from './auth/auth.module';
import { PdfModule } from './pdf/pdf.module';
import { ConversionModule } from './conversion/conversion.module';
import { SpaModule } from './spa/spa.module';
import { HealthModule } from './health/health.module';
import { TaskModule } from './task/task.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { EnvelopeInterceptor } from './common/interceptors/envelope.interceptor';
import { makeGlobalValidationPipe } from './common/pipes/validation.pipe';

@Module({
  imports: [
    ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
    ClientsModule,
    LicenseModule,
    AuthModule,
    PdfModule,
    ConversionModule,
    SpaModule,
    HealthModule,
    TaskModule,
    DashboardModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: makeGlobalValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
  ],
})
export class AppModule {}
