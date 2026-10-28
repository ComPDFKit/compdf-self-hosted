import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ProcessingRequestGuard, isNewProcessingRequest } from './processing-request.guard';
import { RuntimeModeService, RuntimeModeState } from './runtime-mode.service';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

describe('ProcessingRequestGuard', () => {
  it.each([
    ['/api/v1/process/pdf/merge', true],
    ['/api/v1/process/documentai', true],
    ['/api/v1/task/pdf/merge', true],
    ['/api/v1/task/abc/cancel', false],
    ['/api/v1/status', false],
    ['/api/v1/dashboard/runtime-mode', false],
  ])('classifies POST %s as new processing=%s', (path, expected) => {
    expect(isNewProcessingRequest({ method: 'POST', path, url: path } as never)).toBe(expected);
  });

  it('allows new work in normal mode', () => {
    const guard = new ProcessingRequestGuard(modeService('normal'), configService());
    expect(guard.canActivate(contextFor('/api/v1/process/pdf/merge'))).toBe(true);
  });

  it.each(['draining', 'maintenance'] as const)('blocks new work in %s mode with Retry-After', (mode) => {
    const setHeader = vi.fn();
    const guard = new ProcessingRequestGuard(modeService(mode), configService());
    expect(() => guard.canActivate(contextFor('/api/v1/process/pdf/merge', setHeader)))
      .toThrow(ServiceUnavailableException);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('returns the stable maintenance error contract', () => {
    const guard = new ProcessingRequestGuard(modeService('maintenance'), configService());
    try {
      guard.canActivate(contextFor('/api/v1/process/pdf/merge'));
      throw new Error('guard did not block');
    } catch (error) {
      const response = AllExceptionsFilter.toResponse(error);
      expect(response.statusCode).toBe(503);
      expect(response.body).toMatchObject({ code: 150004, errorCode: 'SERVICE_MAINTENANCE' });
    }
  });

  it('keeps task cancellation available during maintenance', () => {
    const guard = new ProcessingRequestGuard(modeService('maintenance'), configService());
    expect(guard.canActivate(contextFor('/api/v1/task/task-1/cancel'))).toBe(true);
  });

  it('consumes a one-time local updater capability for the PDF smoke request', () => {
    const storage = mkdtempSync(join(tmpdir(), 'compdf-smoke-'));
    const token = 'a'.repeat(64);
    const tokenPath = join(storage, '.updater-smoke-token');
    writeFileSync(tokenPath, token, { mode: 0o600 });
    const guard = new ProcessingRequestGuard(modeService('maintenance'), configService(storage));
    expect(guard.canActivate(contextFor('/api/v1/process/pdf/compress', vi.fn(), token))).toBe(true);
    expect(() => readFileSync(tokenPath)).toThrow();
    expect(() => guard.canActivate(contextFor('/api/v1/process/pdf/compress', vi.fn(), token)))
      .toThrow(ServiceUnavailableException);
  });

  it('does not accept the updater capability for another processing route', () => {
    const storage = mkdtempSync(join(tmpdir(), 'compdf-smoke-'));
    const token = 'b'.repeat(64);
    writeFileSync(join(storage, '.updater-smoke-token'), token, { mode: 0o600 });
    const guard = new ProcessingRequestGuard(modeService('maintenance'), configService(storage));
    expect(() => guard.canActivate(contextFor('/api/v1/process/pdf/merge', vi.fn(), token)))
      .toThrow(ServiceUnavailableException);
  });
});

function modeService(mode: RuntimeModeState['mode']): RuntimeModeService {
  return {
    beginProcessingRequest: () => vi.fn(),
    getState: () => ({
      schemaVersion: 1,
      revision: 1,
      mode,
      operator: 'system',
      requestId: 'test',
      reason: 'test',
      updatedAt: new Date().toISOString(),
    }),
  } as RuntimeModeService;
}

function configService(storageDir = 'storage'): ConfigService {
  return { get: (key: string) => key === 'storageDir' ? storageDir : undefined } as ConfigService;
}

function contextFor(path: string, setHeader = vi.fn(), updaterToken?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        once: vi.fn(),
        method: 'POST',
        path,
        url: path,
        headers: updaterToken ? { 'x-compdf-updater-verification': updaterToken } : {},
      }),
      getResponse: () => ({ setHeader, once: vi.fn() }),
    }),
  } as ExecutionContext;
}
