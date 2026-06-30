/**
 * AuthService — admin login (bcrypt verify + JWT issue) and
 * change-password.
 *
 * ★ Redis usage red line: this is the canonical server-local Redis use-case
 * (login-failure rate-limiting, key `auth:fail:<username>`). It NEVER touches the
 * `compdfkit:conc:*` keyspace — concurrency counting lives in the closed-source
 * app. This contrast is intentional: open-source code may rate-limit its OWN
 * admin surface, but must not implement license concurrency.
 *
 * First-login forced change-password is signalled by `last_login_at IS NULL`
 * because the schema has no dedicated column.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { MysqlClient } from '../clients/mysql.client';
import { RedisClient } from '../clients/redis.client';
import { ErrorCode } from '../common/errors/error-codes';
import type { AdminPayload } from './guards/jwt-auth.guard';

const FAIL_WINDOW_SECONDS = 5 * 60; // 5 min
const FAIL_THRESHOLD = 5;

export interface LoginResult {
  token: string;
  username: string;
  role: string;
  mustChangePassword: boolean;
}

@Injectable()
export class AuthService {
  private readonly jwtSecret: string;
  private readonly jwtTtlSeconds: number;

  constructor(
    private readonly db: MysqlClient,
    private readonly redis: RedisClient,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.jwtSecret = config.get<string>('jwt.secret') ?? 'change-me-in-prod';
    this.jwtTtlSeconds = 8 * 60 * 60; // 8h admin session
  }

  async login(username: string, password: string): Promise<LoginResult> {
    await this.assertNotLocked(username);

    const rows = await this.db.query<
      Array<{ id: number; username: string; password_hash: string; role: string; status: number; last_login_at: Date | null }>
    >('SELECT id, username, password_hash, role, status, last_login_at FROM users WHERE username = ? LIMIT 1', [username]);

    const user = rows[0];
    if (!user || user.status !== 1) {
      await this.recordFailure(username);
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      await this.recordFailure(username);
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid credentials' });
    }

    await this.clearFailures(username);
    await this.db.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const payload: AdminPayload = { sub: user.id, username: user.username, role: user.role };
    const token = await this.jwt.signAsync(payload, {
      secret: this.jwtSecret,
      expiresIn: this.jwtTtlSeconds,
    });

    return {
      token,
      username: user.username,
      role: user.role,
      mustChangePassword: user.last_login_at === null,
    };
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<void> {
    const rows = await this.db.query<Array<{ password_hash: string }>>(
      'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    const user = rows[0];
    if (!user) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'user not found' });
    }
    const ok = await bcrypt.compare(oldPassword, user.password_hash);
    if (!ok) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'current password incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await this.db.execute('UPDATE users SET password_hash = ?, last_login_at = NOW() WHERE id = ?', [hash, userId]);
  }

  private async assertNotLocked(username: string): Promise<void> {
    const n = Number(await this.redis.get(`auth:fail:${username}`) ?? 0);
    if (n >= FAIL_THRESHOLD) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'too many failed attempts, try again later',
      });
    }
  }

  private async recordFailure(username: string): Promise<void> {
    await this.redis.incr(`auth:fail:${username}`, FAIL_WINDOW_SECONDS);
  }

  private async clearFailures(username: string): Promise<void> {
    await this.redis.del(`auth:fail:${username}`);
  }
}
