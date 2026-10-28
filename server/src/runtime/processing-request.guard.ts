import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { lstatSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { ErrorCode } from '../common/errors/error-codes';
import { RuntimeModeService } from './runtime-mode.service';
import { PROCESSING_DONE } from './processing-activity.interceptor';

const UPDATER_SMOKE_HEADER = 'x-compdf-updater-verification';
const UPDATER_SMOKE_TOKEN_FILE = '.updater-smoke-token';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

@Injectable()
export class ProcessingRequestGuard implements CanActivate {
  private readonly smokeTokenPath: string;

  constructor(
    private readonly runtimeMode: RuntimeModeService,
    config: ConfigService,
  ) {
    this.smokeTokenPath = join(config.get<string>('storageDir') ?? 'storage', UPDATER_SMOKE_TOKEN_FILE);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!isNewProcessingRequest(request)) return true;
    const state = this.runtimeMode.getState();
    if (state.mode === 'normal') {
      const done = this.runtimeMode.beginProcessingRequest();
      (request as Request & { [PROCESSING_DONE]?: () => void })[PROCESSING_DONE] = done;
      request.once('aborted', done);
      context.switchToHttp().getResponse<Response>().once('finish', done);
      return true;
    }
    if (state.mode === 'maintenance' && isUpdaterSmokeRequest(request) && this.consumeUpdaterSmokeToken(request)) {
      return true;
    }

    context.switchToHttp().getResponse<Response>().setHeader('Retry-After', '60');
    throw new ServiceUnavailableException({
      code: ErrorCode.SERVICE_MAINTENANCE,
      message: `New processing requests are temporarily unavailable while the service is ${state.mode}.`,
    });
  }

  private consumeUpdaterSmokeToken(request: Request): boolean {
    const provided = request.headers[UPDATER_SMOKE_HEADER];
    if (typeof provided !== 'string' || !TOKEN_PATTERN.test(provided)) return false;
    try {
      const info = lstatSync(this.smokeTokenPath);
      if (!info.isFile() || info.size < 1 || info.size > 128) return false;
      const expected = readFileSync(this.smokeTokenPath, 'utf8').trim();
      if (!TOKEN_PATTERN.test(expected)) return false;
      const providedBytes = Buffer.from(provided);
      const expectedBytes = Buffer.from(expected);
      if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) return false;
      unlinkSync(this.smokeTokenPath);
      return true;
    } catch {
      return false;
    }
  }
}

function isUpdaterSmokeRequest(request: Pick<Request, 'method' | 'path' | 'url'>): boolean {
  const path = request.path || request.url.split('?')[0];
  return request.method.toUpperCase() === 'POST' && path === '/api/v1/process/pdf/compress';
}

export function isNewProcessingRequest(request: Pick<Request, 'method' | 'path' | 'url'>): boolean {
  if (request.method.toUpperCase() !== 'POST') return false;
  const path = request.path || request.url.split('?')[0];
  if (path.startsWith('/api/v1/process/')) return true;
  if (path.startsWith('/api/v1/batches')) {
    return !/^\/api\/v1\/batches\/[^/]+\/cancel\/?$/.test(path);
  }
  if (!path.startsWith('/api/v1/task/')) return false;
  return !/^\/api\/v1\/task\/[^/]+\/cancel\/?$/.test(path);
}
