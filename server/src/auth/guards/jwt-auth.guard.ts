/**
 * JwtAuthGuard — protects admin-only API routes.
 *
 * The ComPDF Web (`/api/v1/process/*`, `/api/v1/task/*`) does NOT mount this
 * guard — it is license-gated upstream, not session-gated. Admin-only endpoints
 * such as `/api/v1/auth/change-password` and `/api/v1/license/upload` require a
 * valid admin-session JWT issued by AuthController.login.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MysqlClient } from '../../clients/mysql.client';
import { ErrorCode } from '../../common/errors/error-codes';

export interface AdminPayload {
  sub: number;
  username: string;
  role: string;
  /** Incremented on password change/reset; mismatches invalidate old JWTs. */
  ver: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: MysqlClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const auth: string = req.headers?.authorization ?? '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'missing bearer token' });
    }
    try {
      const payload = await this.jwt.verifyAsync<AdminPayload>(m[1]);
      await this.assertCurrentSession(payload);
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid or expired session' });
    }
  }

  private async assertCurrentSession(payload: AdminPayload): Promise<void> {
    if (!Number.isInteger(payload.sub) || !Number.isInteger(payload.ver)) {
      throw new Error('invalid token payload');
    }
    const rows = await this.db.query<Array<{ status: number; token_version: number }>>(
      'SELECT status, token_version FROM users WHERE id = ? LIMIT 1',
      [payload.sub],
    );
    const user = rows[0];
    if (!user || user.status !== 1 || user.token_version !== payload.ver) {
      throw new Error('stale token');
    }
  }
}
