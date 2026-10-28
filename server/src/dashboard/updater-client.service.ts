import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request as httpRequest } from 'http';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface UpdaterEnvelope<T = unknown> {
  exitCode: number;
  result?: T;
  error?: string;
}

export interface UpdaterResponse<T = unknown> {
  statusCode: number;
  body: UpdaterEnvelope<T>;
}

@Injectable()
export class UpdaterClientService {
  private readonly socketPath: string;

  constructor(config: ConfigService) {
    this.socketPath = config.get<string>('updater.socketPath') ?? '/run/compdf-updater/compdf-updater.sock';
  }

  get<T>(path: string): Promise<UpdaterResponse<T>> {
    return this.call<T>('GET', path);
  }

  post<T>(path: string, body: object, timeoutMs = 30_000): Promise<UpdaterResponse<T>> {
	return this.call<T>('POST', path, body, timeoutMs);
  }

  private call<T>(method: 'GET' | 'POST', path: string, body?: object, timeoutMs = 30_000): Promise<UpdaterResponse<T>> {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        headers: payload ? {
          'content-type': 'application/json',
          'content-length': payload.length,
        } : undefined,
        timeout: timeoutMs,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('updater response exceeds size limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as UpdaterEnvelope<T>;
            if (!Number.isInteger(parsed.exitCode)) throw new Error('invalid updater response');
            resolve({ statusCode: response.statusCode ?? 502, body: parsed });
          } catch {
            reject(new BadGatewayException({ code: 'UPDATER_INVALID_RESPONSE', message: 'Updater returned an invalid response.' }));
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('updater request timed out')));
      request.on('error', () => reject(new BadGatewayException({
        code: 'UPDATER_UNAVAILABLE',
        message: 'The host updater service is unavailable.',
      })));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
