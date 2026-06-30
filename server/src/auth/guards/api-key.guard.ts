/**
 * ApiKeyGuard — CLIENT auth for the v1 PDF/conversion/task API.
 *
 * Clients send `x-api-key: <plaintext>`. The guard hashes it (sha256) and
 * looks up `api_keys` for an active row (status=1) whose key_hash matches.
 * On success it stamps `req.apiKeyId = key_id` (for logging/auditing) and
 * returns true; on missing/invalid/revoked it throws 401.
 *
 * This is SEPARATE from the license token (X-ComPDF-License, attached
 * upstream only) and from JwtAuthGuard (admin sessions). It does
 * NOT touch license/limit logic.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { MysqlClient } from '../../clients/mysql.client';
import { ErrorCode } from '../../common/errors/error-codes';

interface ApiKeyRow {
  key_id: string;
  key_hash: string;
  status: number;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
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
      'SELECT key_id, key_hash, status FROM api_keys WHERE key_hash = ? LIMIT 1',
      [hash],
    );
    const row = rows[0];
    // key_hash already filtered by `WHERE key_hash = ?` above — no need to
    // re-compare here. Missing row (no match) or revoked (status !== 1) → 401.
    if (!row || row.status !== 1) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'invalid or revoked api key' });
    }
    req.apiKeyId = row.key_id;
    return true;
  }
}
