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
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
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
  private readonly logger = new Logger(AuthService.name);
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

  async login(
    username: string,
    password: string,
    opts: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<LoginResult> {
    const ip = opts.ip ?? null;
    const ua = opts.userAgent ?? null;
    await this.assertNotLocked(username, ip, ua);

    const rows = await this.db.query<
      Array<{ id: number; username: string; password_hash: string; role: string; status: number; token_version: number; last_login_at: Date | null }>
    >('SELECT id, username, password_hash, role, status, token_version, last_login_at FROM users WHERE username = ? LIMIT 1', [username]);

    const user = rows[0];
    if (!user) {
      await this.recordFailure(username);
      await this.recordLogin(username, 'fail', 'invalid_credentials', ip, ua);
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid credentials' });
    }
    if (user.status !== 1) {
      await this.recordLogin(username, 'fail', 'user_disabled', ip, ua);
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      await this.recordFailure(username);
      await this.recordLogin(username, 'fail', 'invalid_credentials', ip, ua);
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid credentials' });
    }

    await this.clearFailures(username);
    await this.db.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    await this.recordLogin(username, 'success', 'ok', ip, ua);
    await this.recordUserAction(username, 'login', username, `login: user=${username}`);

    const payload: AdminPayload = { sub: user.id, username: user.username, role: user.role, ver: user.token_version };
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
    const rows = await this.db.query<Array<{ password_hash: string; username: string }>>(
      'SELECT username, password_hash FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    const user = rows[0];
    if (!user) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'user not found' });
    }
    const ok = await bcrypt.compare(oldPassword, user.password_hash);
    if (!ok) {
      // Wrong current password is a validation failure, NOT a session failure.
      // Returning 400 (not 401) keeps the admin axios interceptor from clearing
      // the valid JWT session and redirecting to /admin/login.
      throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: 'current password incorrect' });
    }
    if (newPassword === oldPassword) {
      // New password must differ from the current one. Validation failure, not a
      // session failure — 400 keeps the session intact and blocks the change.
      throw new BadRequestException({ code: ErrorCode.BAD_REQUEST, message: 'new password must differ from current' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await this.db.execute('UPDATE users SET password_hash = ?, last_login_at = NOW(), token_version = token_version + 1 WHERE id = ?', [hash, userId]);
    // PRD §5: admin password change → system log (structured action/target).
    await this.db
      .execute(
        `INSERT INTO operation_logs (log_type, operator, level, result, result_category, action, target, message)
         VALUES ('system', ?, 'INFO', 'success', 'success', 'password_changed', ?, ?)`,
        [user.username.slice(0, 50), user.username, `password_changed: user=${user.username}`],
      )
      .catch((err: Error) => this.logger.warn(`system log write failed: ${err.message}`));
  }

  /**
   * Default-login prompt status for the Dashboard login page. The built-in
   * admin credentials should remain visible until the deployment has recorded
   * its first successful login.
   */
  async getSetupStatus(): Promise<{ needsSetup: boolean }> {
    const rows = await this.db.query<Array<{ c: number }>>(
      "SELECT COUNT(*) AS c FROM login_records WHERE result = 'success'",
      [],
    );
    return { needsSetup: Number(rows[0]?.c ?? 0) === 0 };
  }

  private async assertNotLocked(username: string, ip: string | null, ua: string | null): Promise<void> {
    const n = Number(await this.redis.get(`auth:fail:${username}`) ?? 0);
    if (n >= FAIL_THRESHOLD) {
      await this.recordLogin(username, 'fail', 'locked', ip, ua);
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

  /** Best-effort login audit row. Never throws — a logging outage must not block login. */
  private async recordLogin(
    username: string,
    result: 'success' | 'fail',
    reason: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<void> {
    await this.db
      .execute(
        `INSERT INTO login_records (username, result, reason, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
        [username.slice(0, 50), result, reason, ip, userAgent],
      )
      .catch((err: Error) => this.logger.warn(`login_records write failed: ${err.message}`));
  }

  private async recordUserAction(
    operator: string,
    action: string,
    target: string | null,
    detail: string,
  ): Promise<void> {
    await this.db
      .execute(
        `INSERT INTO operation_logs (log_type, operator, level, result, result_category, action, target, message)
         VALUES ('user_action', ?, 'INFO', 'success', 'success', ?, ?, ?)`,
        [operator.slice(0, 50), action, target, detail],
      )
      .catch((err: Error) => this.logger.warn(`user_action log failed: ${err.message}`));
  }
}
