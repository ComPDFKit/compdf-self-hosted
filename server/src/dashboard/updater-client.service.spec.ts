import { EventEmitter } from 'events';
import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('http', () => ({ request: vi.fn() }));

import { request as httpRequest } from 'http';
import { UpdaterClientService } from './updater-client.service';

const requestMock = vi.mocked(httpRequest);

describe('UpdaterClientService', () => {
  beforeEach(() => requestMock.mockReset());

  it('uses only the configured Unix socket and parses a structured response', async () => {
    let options: Record<string, unknown> | undefined;
    let written = '';
    requestMock.mockImplementation(((actual, callback) => {
      options = actual as Record<string, unknown>;
      const request = new EventEmitter() as EventEmitter & { write(data: Buffer): void; end(): void; destroy(error: Error): void };
      request.write = (data) => { written += data.toString('utf8'); };
      request.destroy = (error) => request.emit('error', error);
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number };
        response.statusCode = 200;
        callback?.(response as never);
        response.emit('data', Buffer.from('{"exitCode":0,"result":{"ok":true}}'));
        response.emit('end');
      };
      return request as never;
    }) as typeof httpRequest);

    const config = { get: () => '/run/compdf-updater/test.sock' } as unknown as ConfigService;
    const result = await new UpdaterClientService(config).post('/v1/check', { currentVersion: '4.1.0' }, 120_000);

    expect(options).toMatchObject({ socketPath: '/run/compdf-updater/test.sock', path: '/v1/check', method: 'POST', timeout: 120_000 });
    expect(JSON.parse(written)).toEqual({ currentVersion: '4.1.0' });
    expect(result).toEqual({ statusCode: 200, body: { exitCode: 0, result: { ok: true } } });
  });

  it('maps invalid updater JSON to a stable gateway error', async () => {
    requestMock.mockImplementation(((_actual, callback) => {
      const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void };
      request.destroy = (error) => request.emit('error', error);
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number };
        response.statusCode = 200;
        callback?.(response as never);
        response.emit('data', Buffer.from('{invalid'));
        response.emit('end');
      };
      return request as never;
    }) as typeof httpRequest);
    const config = { get: () => '/run/compdf-updater/test.sock' } as unknown as ConfigService;
    await expect(new UpdaterClientService(config).get('/v1/status')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
