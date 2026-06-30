/**
 * Outward-facing semantic error codes the server returns to frontends.
 * Forward-compat mappings for license/concurrency overlay signals that the
 * closed-source app may return (402/429). Per docs/sdk-contract.md §5 these
 * will not fire against the current live dev services, but the mapping exists
 * and is unit-testable with mocks.
 */
export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  LICENSE_EXPIRED = 'LICENSE_EXPIRED',
  LICENSE_INVALID = 'LICENSE_INVALID',
  LICENSE_MISSING = 'LICENSE_MISSING',
  CONCURRENCY_LIMIT = 'CONCURRENCY_LIMIT',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  BAD_REQUEST = 'BAD_REQUEST',
}
