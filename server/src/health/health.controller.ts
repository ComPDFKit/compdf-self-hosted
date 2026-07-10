/**
 * HealthController — `GET /api/v1/status` aggregated infra + app probe.
 *
 * Probes:
 *   infra.mysql  — MysqlClient.ping (parameterized ping, best-effort)
 *   infra.redis  — RedisClient.ping
 *   app          — axios GET `${pdfSdk.baseUrl}/livez` (the PDF SDK), with a
 *                  `/health` fallback for older images.
 *   web          — always 'ok' (the server itself is up if it can answer)
 *
 * A downstream failure is caught and reported as 'down' — it never crashes the
 * endpoint. Public and intentionally unauthenticated for container health checks.
 */
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MysqlClient } from '../clients/mysql.client';
import { RedisClient } from '../clients/redis.client';

type Status = 'ok' | 'down';

export interface HealthResponse {
  infra: { mysql: Status; redis: Status };
  app: Status;
  web: Status;
  ts: string;
}

const APP_PROBE_TIMEOUT_MS = 3_000;

@Controller('api/v1/status')
export class HealthController {
  constructor(
    private readonly mysql: MysqlClient,
    private readonly redis: RedisClient,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async status(): Promise<HealthResponse> {
    const baseUrl = this.config.get<string>('pdfSdk.baseUrl') ?? 'http://compdf-app:7001';
    const [mysql, redis, app] = await Promise.all([
      this.mysql.ping().then((ok) => (ok ? 'ok' : 'down') as Status).catch(() => 'down' as Status),
      this.redis.ping().then((ok) => (ok ? 'ok' : 'down') as Status).catch(() => 'down' as Status),
      this.probeApp(baseUrl),
    ]);
    return { infra: { mysql, redis }, app, web: 'ok', ts: new Date().toISOString() };
  }

  private async probeApp(baseUrl: string): Promise<Status> {
    for (const path of ['/livez', '/health']) {
      try {
        // Accept any HTTP response (don't let axios reject on status) and judge
        // healthiness by the status code ourselves. A network failure falls
        // through to the fallback endpoint.
        const res = await axios.get(`${baseUrl}${path}`, {
          timeout: APP_PROBE_TIMEOUT_MS,
          validateStatus: () => true,
        });
        if (res.status >= 200 && res.status < 300) return 'ok';
      } catch {
        // try the fallback endpoint
      }
    }
    return 'down';
  }
}
