/**
 * Shared axios client for the server /api/v1/* routes.
 *
 * Two auth modes, dispatched by URL:
 *   - `/dashboard/*` (admin) → Authorization: Bearer <JWT> from the session in
 *     localStorage (compdf-admin-token). A 401 clears the session and redirects
 *     to /admin/login.
 *   - `/process/*`, `/task/*` (tool calls) →
 *     `x-api-key` from window.COMPDF_CONFIG.apiKey (auto-injected by the
 *     server). A 401 is surfaced to the caller as "API key 为空或错误".
 *
 * Response envelope: every JSON success is wrapped by the server's
 * EnvelopeInterceptor as `{ code:200, msg:'success', data }`. The response
 * interceptor below unwraps `data` so call sites see the payload directly.
 * File-download responses (Blob) don't match the envelope shape and pass through.
 *
 * The server's AllExceptionsFilter returns errors in the matching shape:
 * `{ code, msg, data:null, traceId?, errorCode? }`.
 * File-returning endpoints are fetched with responseType:'blob'; a non-2xx blob
 * is re-read as JSON to extract the normalized error.
 */
import axios, { AxiosError, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

export interface ApiError {
  /** HTTP status code / API code returned by the server. */
  code?: string;
  /** String business code (local thrown code or conversion-engine errorCode). */
  errorCode?: string;
  /** Upstream SDK 6-digit numeric code (upstream errors only). */
  bizCode?: number;
  message: string;
  traceId?: string;
  details?: unknown;
}

type ApiBaseEnv = {
  DEV?: boolean;
  VITE_API_BASE_URL?: string;
};

type ApiLocation = Pick<Location, 'protocol' | 'hostname'>;

export function resolveApiBaseURL(
  env: ApiBaseEnv = import.meta.env,
  locationLike: ApiLocation = window.location,
): string {
  const configured = env.VITE_API_BASE_URL?.trim();
  if (configured) return normalizeConfiguredApiBaseURL(configured, locationLike);
  if (env.DEV) return '/api/v1';
  return '/api/v1';
}

function normalizeConfiguredApiBaseURL(configured: string, locationLike: ApiLocation): string {
  try {
    const url = new URL(configured);
    if (isLoopbackHost(url.hostname) && !isLoopbackHost(locationLike.hostname)) {
      url.hostname = locationLike.hostname;
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // Relative paths such as /api/v1 are valid axios base URLs.
  }
  return configured;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host === '[::1]'
    || host.startsWith('127.');
}

// ---- Admin session (JWT) -------------------------------------------------

const TOKEN_KEY = 'compdf-admin-token';

export interface StoredSession {
  token: string;
  username: string;
  role: string;
  mustChangePassword: boolean;
}

export function loadSession(): StoredSession | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StoredSession;
    if (s && typeof s.token === 'string') return s;
  } catch {
    /* corrupt — fall through to clear */
  }
  localStorage.removeItem(TOKEN_KEY);
  return null;
}

export function saveSession(s: StoredSession): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY);
}

// ---- axios instance ------------------------------------------------------

function isAdminRoute(url: string | undefined): boolean {
  if (!url) return false;
  // /dashboard/* always requires JWT; /auth/change-password and /license/upload
  // are the two non-dashboard routes that also require an admin JWT session
  // (CLAUDE.md auth model). Other routes are public (login/setup/license GET/
  // branding) or use x-api-key (tool routes).
  return url.startsWith('/dashboard/') || url.startsWith('dashboard/')
    || url.startsWith('/auth/change-password') || url.startsWith('auth/change-password')
    || url.startsWith('/license/upload') || url.startsWith('license/upload');
}

export const http: AxiosInstance = axios.create({
  baseURL: resolveApiBaseURL(),
  timeout: 300_000, // conversion can be slow
});

/** Alias kept for the Web Demo tool views, which import `apiClient`. */
export const apiClient: AxiosInstance = http;

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const url = config.url ?? '';
  config.headers = config.headers ?? {};
  if (isAdminRoute(url)) {
    const s = loadSession();
    if (s?.token) config.headers.Authorization = `Bearer ${s.token}`;
  } else {
    // Tool/conversion/task routes require x-api-key. Auto-injected deployment key.
    const apiKey = window.COMPDF_CONFIG?.apiKey;
    if (apiKey) config.headers['x-api-key'] = apiKey;
  }
  return config;
});

http.interceptors.response.use(
  (response) => {
    // Unwrap the server's success envelope `{ code:200, msg:'success', data }`
    // so call sites see the payload directly. Blob/HTML responses don't match
    // the envelope shape and pass through untouched.
    const body = response?.data;
    const code = (body as { code?: unknown } | undefined)?.code;
    const isSuccessCode = code === 200 || (typeof code === 'string' && /^2\d\d$/.test(code));
    if (body && typeof body === 'object' && !Array.isArray(body)
      && isSuccessCode
      && (body as { msg?: unknown }).msg === 'success'
      && 'data' in body) {
      response.data = (body as { data: unknown }).data;
    }
    return response;
  },
  (err) => {
    if (err?.response?.status === 401) {
      const url: string | undefined = err.config?.url;
      if (isAdminRoute(url) && !isCurrentPasswordIncorrect(err)) {
        clearSession();
        if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/admin/login')) {
          window.location.assign('/admin/login');
        }
      }
      // Tool-route 401 (bad/missing API key) is surfaced to the caller.
    }
    return Promise.reject(err);
  },
);

/**
 * Defensive guard: a wrong current password on /auth/change-password is a
 * validation failure, not a session failure. The backend returns 400 for this,
 * but older backends may still return 401 — don't log the user out in that case.
 */
function isCurrentPasswordIncorrect(err: unknown): boolean {
  const body = (err as AxiosError<any>)?.response?.data;
  if (typeof body !== 'object' || body === null) return false;
  const msg = typeof body.msg === 'string' ? body.msg : body.message;
  return typeof msg === 'string' && msg.toLowerCase().includes('current password incorrect');
}

// ---- error + download helpers (Web Demo) --------------------------------

/** Turn any axios error into a plain ApiError for the UI. */
export async function toApiError(err: unknown): Promise<ApiError> {
  const ax = err as AxiosError<any>;
  const body = ax?.response?.data;
  // Blob error bodies (from responseType:'blob' requests) are not auto-parsed.
  if (body instanceof Blob) {
    const parsed = await parseBlobJson(body);
    if (parsed && typeof parsed === 'object') return normalizeApiErrorBody(parsed as Record<string, unknown>);
    return { message: 'Request failed. Please try again later.' };
  }
  if (body && typeof body === 'object' && (typeof body.msg === 'string' || typeof body.message === 'string')) {
    return normalizeApiErrorBody(body as Record<string, unknown>);
  }
  if (ax?.message) return { message: ax.message };
  return { message: 'Unknown error' };
}

async function parseBlobJson(body: Blob): Promise<unknown | null> {
  try {
    const text = await body.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function normalizeApiErrorBody(body: Record<string, unknown>): ApiError {
  const msg = typeof body.msg === 'string' ? body.msg
    : typeof body.message === 'string' ? body.message
    : 'Request failed. Please try again later.';
  const code = body.code;
  return {
    code: typeof code === 'number' ? String(code) : (code as string | undefined),
    errorCode: typeof body.errorCode === 'string' ? body.errorCode : undefined,
    bizCode: typeof body.bizCode === 'number' ? body.bizCode : undefined,
    message: msg,
    traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
    details: body.details,
  };
}

/**
 * Trigger a browser download from a blob-bearing axios response. The server
 * sets a sanitized Content-Disposition; we fall back to `fallbackFilename`.
 */
export function downloadBlob(res: AxiosResponse<Blob>, fallbackFilename: string): void {
  const cd = res.headers['content-disposition'] as string | undefined;
  const filename = parseContentDispositionFilename(cd) ?? fallbackFilename;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function parseContentDispositionFilename(contentDisposition: string | undefined): string | undefined {
  if (!contentDisposition) return undefined;
  const encoded = contentDisposition.match(/(?:^|;)\s*filename\*=(?:UTF-8'')?([^;]+)/i);
  if (encoded) return decodeHeaderFilename(encoded[1]);
  const plain = contentDisposition.match(/(?:^|;)\s*filename="?([^";]+)"?/i);
  return plain ? decodeHeaderFilename(plain[1]) : undefined;
}

function decodeHeaderFilename(raw: string): string {
  const value = raw.trim().replace(/^"|"$/g, '');
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
