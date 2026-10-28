/**
 * AppModule — assembles the ComPDF self-hosted server.
 *
 * Global cross-cutting concerns are registered here via APP_* tokens (preferred
 * over useGlobal* in main.ts — cleaner and DI-testable):
 *   - APP_PIPE:           ValidationPipe (whitelist + transform)
 *   - APP_FILTER:         AllExceptionsFilter (normalizes BOTH upstream dialects)
 *   - APP_GUARD:          ProcessingRequestGuard (blocks new work while draining/maintenance)
 *   - APP_INTERCEPTOR:    LoggingInterceptor (writes operation_logs)
 *                          then EnvelopeInterceptor (wraps JSON success in {code,msg,data})
 *
 * ConfigModule is global so every client/service can read ConfigService. The
 * four egress/infra clients live in the shared ClientsModule (single ownership).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import configuration from './configuration';
import { ClientsModule } from './clients/clients.module';
import { LicenseModule } from './license/license.module';
import { AuthModule } from './auth/auth.module';
import { PdfModule } from './pdf/pdf.module';
import { ConversionModule } from './conversion/conversion.module';
import { SpaModule } from './spa/spa.module';
import { HealthModule } from './health/health.module';
import { TaskModule } from './task/task.module';
import { BatchModule } from './batch/batch.module';
import { McpModule } from './mcp/mcp.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { EnvelopeInterceptor } from './common/interceptors/envelope.interceptor';
import { makeGlobalValidationPipe } from './common/pipes/validation.pipe';
import { RuntimeModule } from './runtime/runtime.module';
import { ProcessingRequestGuard } from './runtime/processing-request.guard';

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
    BatchModule,
    DashboardModule,
    RuntimeModule,
    McpModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: makeGlobalValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ProcessingRequestGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
  ],
})
export class AppModule {}
