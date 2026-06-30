/**
 * Pure credential generation for first-boot database seeding.
 * No database or environment dependencies; called by init-db.ts.
 * Hashing must match the verification path:
 *   - hashPassword: bcrypt, checked by AuthService
 *   - hashApiKey: sha256 hex, checked by ApiKeyGuard
 */
import { randomBytes, createHash } from 'crypto';
import * as bcrypt from 'bcrypt';

export const ADMIN_USERNAME = 'admin';

/** Strong random password, URL-safe base64. */
export function genPassword(byteLen = 18): string {
  return randomBytes(byteLen).toString('base64url');
}

/** Public key id for display plus the x-api-key secret shown once. */
export function genApiKey(): { keyId: string; secret: string } {
  const keyId = randomBytes(8).toString('hex'); // 16 hex
  const secret = randomBytes(24).toString('base64url');
  return { keyId, secret };
}

/** bcrypt password hash, cost 10. */
export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

/** sha256 hex, matching ApiKeyGuard. */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret.trim()).digest('hex');
}
