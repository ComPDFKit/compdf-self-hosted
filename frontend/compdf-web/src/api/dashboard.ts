/**
 * Dashboard API client — typed wrappers over the admin endpoints. All routes
 * require the admin JWT (attached by api/client.ts interceptor). Shapes mirror
 * server/src/dashboard/dashboard.dto.ts.
 */
import { http } from './client';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LogEntry {
  id: number;
  logType: string;
  operator: string | null;
  method: string | null;
  endpoint: string | null;
  feature: string | null;
  fileInfo: string | null;
  statusCode: number | null;
  level: string;
  result: string | null;
  resultCategory: string | null;
  action: string | null;
  target: string | null;
  durationMs: number | null;
  message: string | null;
  stack?: string | null;
  createdAt: string;
}

export interface LoginRecord {
  id: number;
  username: string;
  result: string;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface ApiKeyInfo {
  keyId: string;
  key: string | null;
  status: number;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface OverviewToday {
  success: number;
  invalid: number;
  fail: number;
  exception: number;
  errorTotal: number;
  total: number;
  avgSuccessDurationMs: number | null;
}

export interface TrendPoint extends OverviewToday {
  date: string;
}

export interface Overview {
  today: OverviewToday;
  trend7d: TrendPoint[];
  apiKeys: ApiKeyInfo[];
}

export type OverviewRange = '24h' | 'week' | 'month';

export interface BrandSettings {
  siteName: string;
  logoPath: string | null;
  themeColor: string;
  locale: string;
  darkMode: boolean;
  fileRetentionDays: number;
  upgradeBannerText: string | null;
  docUrl: string | null;
  contactUrl: string | null;
  announcementsJson: string | null;
  updatedAt: string;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releasedAt: string | null;
  changelogUrl: string | null;
  image: string | null;
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
export type LogType = 'user_action' | 'api_call' | 'error' | 'system';
export type LogTimeRange = '15m' | '1h' | '6h' | '24h' | 'custom';

export interface LogsQuery {
  level?: LogLevel;
  logType?: LogType;
  keyword?: string;
  operator?: string;
  timeRange?: LogTimeRange;
  startTime?: string;
  endTime?: string;
  page?: number;
  pageSize?: number;
}

export interface UpdateSettings {
  siteName?: string;
  themeColor?: string;
  locale?: string;
  darkMode?: boolean;
  upgradeBannerText?: string;
  docUrl?: string;
  contactUrl?: string;
}

export const dashboardApi = {
  overview: (params?: { range?: OverviewRange }) => http.get<Overview>('/dashboard/overview', { params }).then((r) => r.data),
  logs: (q: LogsQuery) => http.get<Paged<LogEntry>>('/dashboard/logs', { params: q }).then((r) => r.data),
  log: (id: number) => http.get<LogEntry>(`/dashboard/logs/${id}`).then((r) => r.data),
  loginRecords: (page = 1, pageSize = 20) =>
    http.get<Paged<LoginRecord>>('/dashboard/login-records', { params: { page, pageSize } }).then((r) => r.data),
  apiKeys: () => http.get<ApiKeyInfo[]>('/dashboard/api-keys').then((r) => r.data),
  version: () => http.get<VersionInfo>('/dashboard/version').then((r) => r.data),
  updateAccount: (username: string) => http.patch('/dashboard/account', { username }).then((r) => r.data),
  getSettings: () => http.get<BrandSettings>('/dashboard/settings').then((r) => r.data),
  updateSettings: (patch: UpdateSettings) => http.put<BrandSettings>('/dashboard/settings', patch).then((r) => r.data),
  uploadLogo: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return http.post<BrandSettings>('/dashboard/settings/logo', form).then((r) => r.data);
  },
  /** Trigger a CSV download of the current log filter. */
  exportLogs: (q: LogsQuery) =>
    http.get('/dashboard/logs/export', { params: q, responseType: 'blob' }).then((r) => r.data as Blob),
  /** Report a non-API Web UI failure to be logged as an error row. Best-effort. */
  reportClientError: (payload: { message: string; stack?: string; context?: string }) =>
    http.post('/dashboard/logs/client-error', payload).then((r) => r.data),
};
