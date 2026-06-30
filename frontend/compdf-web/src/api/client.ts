/**
 * Shared axios client for the middleware /api/v1/* routes.
 *
 * The middleware's AllExceptionsFilter returns upstream SDK errors in the same
 * OpenAPI-style shape as the underlying services:
 * `{ code, message, traceId, errorCode? }`.
 * File-returning endpoints are fetched with responseType:'blob'; a non-2xx blob
 * is re-read as JSON to extract the normalized error.
 */
import axios, { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios';

export interface ApiError {
  code?: string | number;
  errorCode?: string;
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
  if (configured) return configured;
  if (env.DEV) return `${locationLike.protocol}//${locationLike.hostname}:8080/api/v1`;
  return '/api/v1';
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: resolveApiBaseURL(),
  timeout: 300_000, // conversion can be slow
});

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
  if (body && typeof body === 'object' && typeof body.message === 'string') {
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
  return {
    code: body.code as string | number | undefined,
    errorCode: typeof body.errorCode === 'string' ? body.errorCode : undefined,
    message: typeof body.message === 'string' ? body.message : 'Request failed. Please try again later.',
    traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
    details: body.details,
  };
}

/**
 * Trigger a browser download from a blob-bearing axios response. The middleware
 * sets a sanitized Content-Disposition; we fall back to `fallbackFilename`.
 */
export function downloadBlob(res: AxiosResponse<Blob>, fallbackFilename: string): void {
  const cd = res.headers['content-disposition'] as string | undefined;
  let filename = fallbackFilename;
  if (cd) {
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) filename = decodeURIComponent(m[1]);
  }
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
