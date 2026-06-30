/**
 * JwtAuthGuard — protects admin-only API routes.
 *
 * The ComPDF Web (`/api/v1/pdf/*`, `/api/v1/conversion/*`) does NOT mount this
 * guard — it is license-gated upstream, not session-gated. Admin-only endpoints
 * such as `/api/v1/auth/change-password` and `/api/v1/license/upload` require a
 * valid admin-session JWT issued by AuthController.login.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ErrorCode } from '../../common/errors/error-codes';

export interface AdminPayload {
  sub: number;
  username: string;
  role: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const auth: string = req.headers?.authorization ?? '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'missing bearer token' });
    }
    try {
      const payload = await this.jwt.verifyAsync<AdminPayload>(m[1]);
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid or expired session' });
    }
  }
}
