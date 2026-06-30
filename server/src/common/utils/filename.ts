/**
 * filename.ts — sanitize untrusted filenames for Content-Disposition headers.
 *
 * Upstream PDF/conversion engines return a `Content-Disposition` header whose
 * `filename` is untrusted (a compromised or MITM upstream could inject CRLF,
 * extra header params, or path-traversal segments). We NEVER pass the raw
 * upstream header through verbatim. Instead we parse the filename out (when
 * present), sanitize it, and let the caller rebuild `attachment; filename="..."`
 * from the sanitized bare filename.
 *
 * Sanitization removes every character that could break out of the quoted
 * string or traverse the filesystem: CR/LF (response-header splitting),
 * backslash and double-quote (escape/quoting breakout), and path separators
 * (`/`, `\`). Results are truncated to 255 chars and fall back to a
 * caller-supplied default when empty.
 */

const MAX_FILENAME_LENGTH = 255;

/** Characters that must never appear inside a Content-Disposition filename. */
const UNSAFE_FILENAME_CHARS = /[\r\n"\\\/]/g;

/**
 * Return a safe bare filename (no quotes, no slashes, no CR/LF). When `name` is
 * absent or sanitizes to empty, returns `fallback` (itself sanitized). The
 * returned string is safe to embed inside a double-quoted Content-Disposition
 * `filename` parameter. When even the fallback is empty, a last-resort `'file'`
 * is used so the header is never `attachment; filename=""`.
 */
export function sanitizeFilename(
  name: string | undefined | null,
  fallback: string,
): string {
  const cleaned = strip(name);
  if (cleaned) return cleaned;
  return strip(fallback) || 'file';
}

/**
 * Parse a filename out of an upstream `Content-Disposition` header value.
 * Accepts plain `filename="..."` and `filename*=UTF-8''...` (RFC 5987), and
 * percent-decodes the result. Returns `undefined` when the header is absent or
 * carries no filename parameter — the caller then supplies a fallback via
 * `sanitizeFilename`. The returned value is NOT yet sanitized; pass it through
 * `sanitizeFilename` before placing it in a response header.
 */
export function parseFilenameFromHeader(
  contentDisposition: string | undefined | null,
): string | undefined {
  if (!contentDisposition) return undefined;
  const m = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!m) return undefined;
  let name = m[1];
  try {
    name = decodeURIComponent(name);
  } catch {
    /* not valid percent-encoding — keep the raw capture */
  }
  return name;
}

function strip(v: string | undefined | null): string {
  if (typeof v !== 'string') return '';
  return v.replace(UNSAFE_FILENAME_CHARS, '').trim().slice(0, MAX_FILENAME_LENGTH);
}
