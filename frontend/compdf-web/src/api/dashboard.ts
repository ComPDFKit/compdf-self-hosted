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

export interface McpConfiguration {
  enabled: boolean;
  url: string;
  transport: 'streamable-http';
  authentication: { header: string; credential: string };
  tools: string[];
  limits: { maxInlineFileBytes: number; maxFileBytes: number; maxFiles: number; maxTotalBytes: number };
  clients: {
    claudeDesktop: Record<string, unknown>;
    claudeCode: Record<string, unknown>;
    vscode: Record<string, unknown>;
    codexToml: string;
  };
}

export interface McpServiceStatus {
  status: 'running' | 'not_enabled' | 'error';
  checkedAt: string;
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

export interface LicenseDisplay {
  sub?: string;
  fileName?: string;
  startTime?: string;
  endTime?: string;
  scope?: unknown;
  limits?: unknown;
  status: 'valid' | 'expiring' | 'expired' | 'inactive';
  present: boolean;
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
  releaseNotes: string | null;
}

export type UpdatePhase =
  | 'AVAILABLE' | 'DOWNLOADING' | 'VERIFIED' | 'PRECHECKED' | 'BACKING_UP' | 'BACKED_UP'
  | 'DRAINING' | 'MIGRATING' | 'DEPLOYING' | 'VERIFYING' | 'COMMITTED'
  | 'FAILED' | 'PAUSED' | 'ROLLBACK_REQUIRED' | 'ROLLED_BACK';

export interface UpdateEvent {
  revision: number;
  phase: UpdatePhase;
  message: string;
  at: string;
}

export interface UpdateJob {
  requestId: string;
  currentVersion: string;
  targetVersion: string;
  delivery: 'online' | 'offline';
  phase: UpdatePhase;
	resumePhase?: UpdatePhase;
  failure?: string;
  backupId?: string;
  progress?: { stage: string; item?: string; completedBytes: number; totalBytes: number; percent: number; indeterminate?: boolean };
  recovery?: { applicationRollbackAllowed: boolean; databaseRestoreRequired: boolean };
  revision: number;
  updatedAt: string;
  events: UpdateEvent[];
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  availableVersion: string;
  channel: string;
  maintenanceRequired: boolean;
  rollback: { application: boolean; database: boolean; requiresBackupRestore: boolean };
  releaseNotes: string;
  knownIssues: string[];
}

export interface PreflightReport {
  overall: 'pass' | 'warn' | 'block';
  checks: Array<{ id: string; level: 'pass' | 'warn' | 'block'; message: string; details?: Record<string, string> }>;
}

export interface RuntimeModeStatus {
  state: { mode: 'normal' | 'draining' | 'maintenance'; revision: number; updatedAt: string };
  tasks: { pending: number; processing: number; active: number; drained: boolean; observedAt: string };
}

export interface UpdateAutomationStatus {
  policy: { checkIntervalMinutes: number; jitterPercent: number; maximumBackoffMinutes: number; autoDownload: boolean; retainReleases: number; downloadBytesPerSecond?: number };
  status: { lastAttemptAt?: string; lastSuccessAt?: string; nextAttemptAt?: string; consecutiveErrors: number; lastError?: string; availableVersion?: string; downloaded: boolean };
}

export interface RefreshedSession {
  token: string;
  username: string;
  role: string;
  avatarUrl: string | null;
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
  darkMode?: boolean;
  upgradeBannerText?: string;
  docUrl?: string;
  contactUrl?: string;
}

export const dashboardApi = {
  mcpConfiguration: () => http.get<McpConfiguration>('/dashboard/mcp', { timeout: 10_000 }).then((r) => r.data),
  mcpStatus: () => http.get<McpServiceStatus>('/dashboard/mcp/status', { timeout: 10_000 }).then((r) => r.data),
  licenseDisplay: () => http.get<LicenseDisplay>('/license').then((r) => r.data),
  downloadLicense: () => http.get<Blob>('/license/download', { responseType: 'blob' }),
  licenseUpdateStatus: () => http.get<LicenseUpdateStatus | null>('/dashboard/license/update', { timeout: 10_000 }).then((r) => r.data),
  updateLicense: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    form.append('approve', 'true');
    return http.post<LicenseUpdateStatus>('/dashboard/license/update', form).then((r) => r.data);
  },
  recoverLicense: () => http.post<LicenseUpdateStatus>('/dashboard/license/recover').then((r) => r.data),
  overview: (params?: { range?: OverviewRange }) => http.get<Overview>('/dashboard/overview', { params }).then((r) => r.data),
  logs: (q: LogsQuery) => http.get<Paged<LogEntry>>('/dashboard/logs', { params: q }).then((r) => r.data),
  log: (id: number) => http.get<LogEntry>(`/dashboard/logs/${id}`).then((r) => r.data),
  loginRecords: (page = 1, pageSize = 20) =>
    http.get<Paged<LoginRecord>>('/dashboard/login-records', { params: { page, pageSize } }).then((r) => r.data),
  apiKeys: () => http.get<ApiKeyInfo[]>('/dashboard/api-keys').then((r) => r.data),
  recordApiKeyAction: (keyId: string, action: 'view' | 'copy') =>
    http.post<{ ok: true }>('/dashboard/api-keys/actions', { keyId, action }).then((r) => r.data),
  version: () => http.get<VersionInfo>('/dashboard/version').then((r) => r.data),
  updateStatus: () => http.get<UpdateJob | null>('/dashboard/update/current', { timeout: 5_000 }).then((r) => r.data),
  updateHistory: () => http.get<UpdateJob[]>('/dashboard/update/history').then((r) => r.data),
  updateAutomation: () => http.get<UpdateAutomationStatus>('/dashboard/update/automation').then((r) => r.data),
  checkUpdate: (currentVersion: string) => http.post<UpdateCheckResult>('/dashboard/update/check', { currentVersion }).then((r) => r.data),
  downloadUpdate: (payload: { currentVersion: string; targetVersion: string; requestId: string }) =>
    http.post<{ job: UpdateJob }>('/dashboard/update/download', payload).then((r) => r.data),
  cancelUpdate: (payload: { requestId: string }) =>
    http.post<{ status: string; job: UpdateJob }>('/dashboard/update/cancel', payload).then((r) => r.data),
  preflightUpdate: (payload: { currentVersion: string; targetVersion: string; requestId: string }) =>
    http.post<PreflightReport>('/dashboard/update/preflight', payload).then((r) => r.data),
  backupUpdate: (payload: { currentVersion: string; requestId: string; approve: boolean; maintenanceConfirmed: boolean }) =>
    http.post('/dashboard/update/backup', payload, { timeout: 120_000 }).then((r) => r.data),
  applyUpdate: (payload: { currentVersion: string; targetVersion: string; requestId: string; approve: boolean; maintenanceConfirmed: boolean; offlineRiskConfirmed?: boolean }) =>
    http.post<{ job: UpdateJob }>('/dashboard/update/apply', payload).then((r) => r.data),
  rollbackUpdate: (payload: { requestId: string; approve: boolean }) =>
    http.post<{ job: UpdateJob }>('/dashboard/update/rollback', payload).then((r) => r.data),
  runtimeMode: () => http.get<RuntimeModeStatus>('/dashboard/runtime-mode').then((r) => r.data),
  setRuntimeMode: (payload: { mode: 'normal' | 'draining' | 'maintenance'; requestId: string; reason: string }) =>
    http.put<RuntimeModeStatus>('/dashboard/runtime-mode', payload).then((r) => r.data),
  updateAccount: (username: string) => http.patch<RefreshedSession>('/dashboard/account', { username }).then((r) => r.data),
  uploadAccountAvatar: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return http.post<{ avatarUrl: string | null }>('/dashboard/account/avatar', form).then((r) => r.data);
  },
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

export interface LicenseUpdateStatus {
  requestId: string;
  phase: string;
  updatedAt: string;
  sha256?: string;
  error?: string;
}
