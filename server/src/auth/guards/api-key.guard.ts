/**
 * ApiKeyGuard — CLIENT auth for the v1 PDF/conversion/task API.
 *
 * Clients send `x-api-key: <plaintext>`. The guard hashes it (sha256) and
 * looks up `api_keys` for an active row (status=1) whose key_hash matches.
 * On success it stamps `req.apiKeyId = key_id` and `req.apiKeyOwner` (the
 * creating Dashboard user, for logging/auditing) and
 * returns true; on missing/invalid/revoked it throws 401.
 *
 * This is SEPARATE from JwtAuthGuard (admin sessions). It does NOT touch
 * license/limit logic.
 */
import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { MysqlClient } from '../../clients/mysql.client';
import { ErrorCode } from '../../common/errors/error-codes';

interface ApiKeyRow {
  key_id: string;
  key_hash: string;
  status: number;
  owner_username: string | null;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly mysql: MysqlClient,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const raw = req.headers?.['x-api-key'];
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'missing x-api-key' });
    }
    const hash = createHash('sha256').update(raw.trim()).digest('hex');
    const rows = await this.mysql.query<ApiKeyRow[]>(
      `SELECT api_keys.key_id, api_keys.key_hash, api_keys.status, users.username AS owner_username
       FROM api_keys
       LEFT JOIN users ON users.id = api_keys.created_by_user_id
       WHERE api_keys.key_hash = ? LIMIT 1`,
      [hash],
    );
    const row = rows[0];
    // key_hash already filtered by `WHERE key_hash = ?` above — no need to
    // re-compare here. Missing row (no match) or revoked (status !== 1) → 401.
    if (!row || row.status !== 1) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid or revoked api key' });
    }
    req.apiKeyId = row.key_id;
    req.apiKeyOwner = row.owner_username;
    // Keep the management page's last-used value in sync with every
    // authenticated API-key request. This is best-effort so an audit
    // timestamp failure never turns a valid client request into a 5xx.
    await this.mysql
      .execute('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_id = ?', [row.key_id])
      .catch((err: Error) => this.logger.warn(`last-used timestamp update failed: ${err.message}`));
    return true;
  }
}
