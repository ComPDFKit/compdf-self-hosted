/**
 * Redis client — ioredis singleton.
 *
 * ★ Protection sink-down red line: this client is for server-local caching /
 * rate-limiting ONLY (e.g. admin login-failure counts). It MUST NEVER touch the
 * `compdfkit:conc:*` keyspace because concurrency counting lives inside the
 * closed-source app.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisClient implements OnModuleDestroy {
  private readonly logger = new Logger(RedisClient.name);
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('redis.host') ?? 'compdf-infra';
    const port = this.config.get<number>('redis.port') ?? 6379;
    this.redis = new Redis({
      host,
      port,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
    // `on('error')` logs only — never crashes the process. A transient Redis
    // outage must not take the server down (caching/rate-limit are best-effort).
    this.redis.on('error', (err: Error) => {
      this.logger.error(`redis error: ${err.message}`);
    });
    this.redis.on('connect', () => this.logger.log('redis connected'));
  }

  /** Underlying ioredis instance (for caching/rate-limit use-cases). */
  get instance(): Redis {
    return this.redis;
  }

  /** Best-effort ping; resolves true/false rather than throwing. */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.redis.ping();
      return reply === 'PONG';
    } catch (err) {
      this.logger.warn(`redis ping failed: ${(err as Error).message}`);
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1 && ttlSeconds && ttlSeconds > 0) {
      await this.redis.expire(key, ttlSeconds);
    }
    return n;
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
