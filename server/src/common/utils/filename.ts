/**
 * filename.ts — sanitize untrusted filenames for Content-Disposition headers.
 *
 * Upstream PDF/conversion engines return a `Content-Disposition` header whose
 * `filename` is untrusted (a compromised or MITM upstream could inject CRLF,
 * extra header params, or path-traversal segments). We NEVER pass the raw
 * upstream header through verbatim. Instead we parse the filename out (when
 * present), sanitize it, and let the caller rebuild a safe attachment header.
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
 * returned string is safe to encode into Content-Disposition parameters. When
 * even the fallback is empty, a last-resort `'file'` is used.
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
 * Multer can expose multipart filenames as latin1-decoded mojibake when the
 * browser sent UTF-8 bytes. Repair only when the latin1->utf8 round trip clearly
 * improves the string; otherwise leave valid names such as `résumé.pdf` alone.
 */
export function normalizeUploadedFilename(name: string): string {
  const repaired = Buffer.from(name, 'latin1').toString('utf8');
  if (repaired.includes('\uFFFD')) return name;
  return filenameRepairScore(repaired) > filenameRepairScore(name) ? repaired : name;
}

/**
 * Build a Content-Disposition attachment header that preserves non-ASCII
 * filenames. `filename` is kept as a conservative ASCII fallback for older
 * clients, while RFC 5987 `filename*` carries the UTF-8 filename browsers use.
 */
export function contentDispositionAttachment(filename: string): string {
  const safe = sanitizeFilename(filename, 'file');
  const asciiFallback = asciiFilenameFallback(safe);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(safe)}`;
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
  const encoded = contentDisposition.match(/(?:^|;)\s*filename\*=(?:UTF-8'')?([^;]+)/i);
  if (encoded) return decodeHeaderFilename(encoded[1]);
  const plain = contentDisposition.match(/(?:^|;)\s*filename="?([^";]+)"?/i);
  if (!plain) return undefined;
  return decodeHeaderFilename(plain[1]);
}

function decodeHeaderFilename(raw: string): string {
  let name = raw.trim().replace(/^"|"$/g, '');
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

function asciiFilenameFallback(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[%;]/g, '')
    .trim();
  return ascii || 'file';
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

function filenameRepairScore(value: string): number {
  let score = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) score += 3;
    if (code >= 0x3040 && code <= 0x30ff) score += 3;
    if (code >= 0xac00 && code <= 0xd7af) score += 3;
    if (code >= 0x0080 && code <= 0x009f) score -= 4;
    if ('ÃÂãäåæçèéïð'.includes(char)) score -= 1;
  }
  return score;
}
