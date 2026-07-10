/**
 * ValidationPipe — global whitelist + transform (strips unknown props, coerces
 * types). Applied globally in main.ts so every DTO is validated uniformly.
 */
import { ValidationPipe } from '@nestjs/common';

export function makeGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: false,
    transformOptions: { enableImplicitConversion: true },
  });
}
