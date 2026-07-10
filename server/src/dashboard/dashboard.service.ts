/**
 * DashboardService — aggregate reads for the admin Dashboard.
 *
 * All data comes from existing tables (operation_logs, login_records, api_keys).
 * No license enforcement — display only (CLAUDE.md red line). License info is
 * intentionally NOT surfaced in the dashboard (deferred per scope decision).
 *
 * `recordUserAction()` is called by the controller after mutating operations
 * (settings change, logo upload, username change). The LoggingInterceptor only
 * writes api_call/error rows, so user_action entries must be explicit — and
 * best-effort (a log write failure must not break the op).
 */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ApiKeyService } from '../auth/api-key.service';
import { MysqlClient } from '../clients/mysql.client';
import { UpdateCheckService } from './update-check.service';
import {
  ApiKeyInfo, LogEntry, LoginRecord, LogsQueryDto, Overview,
  OverviewRange, OverviewToday, Paged, TrendPoint, VersionInfo,
} from './dashboard.dto';

/**
 * Endpoint filter scoping the Overview success metric to the tool-route
 * prefixes. Dashboard/auth/branding reads are admin overhead, not tool usage,
 * so they're excluded.
 *
 * Static constant — never interpolates user input — so embedding it in SQL is
 * injection-safe.
 */
const TOOL_ROUTE_FILTER = `endpoint LIKE '/api/v1/process/%' OR endpoint LIKE '/api/v1/task%'`;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly mysql: MysqlClient,
    private readonly updateCheck: UpdateCheckService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async getOverview(range: OverviewRange = 'week'): Promise<Overview> {
    const [today, trend7d, apiKeys] = await Promise.all([
      this.getTodayData(range),
      this.getTrend7d(range),
      this.getApiKeys(),
    ]);
    return { today, trend7d, apiKeys };
  }

  private async getTodayData(range: OverviewRange): Promise<OverviewToday> {
    const config = overviewRangeConfig(range);
    // PRD §5: 成功/无效/失败/异常 四分类 + 错误总数 + 成功平均耗时.
    // Scoped to the four tool-route prefixes (TOOL_ROUTE_FILTER) — dashboard/
    // auth/branding reads are admin overhead, not tool usage. user_action/system
    // rows have NULL endpoint and are excluded by the LIKE filter.
    // NOTE: no log_type filter — error rows (log_type='error', category ∈
    // invalid/fail/exception) MUST be included so the error categories count.
    // duration_ms is non-NULL only for success rows, so AVG() naturally yields
    // the success-only average (NULLs are ignored).
    const rows = await this.mysql.query<
      Array<{ result_category: string | null; c: number; avg_dur: number | null }>
    >(
      `SELECT result_category, COUNT(*) AS c, AVG(duration_ms) AS avg_dur
       FROM operation_logs
       WHERE ${config.whereSql}
         AND (${TOOL_ROUTE_FILTER})
       GROUP BY result_category`,
    );
    let success = 0, invalid = 0, fail = 0, exception = 0;
    let avgSuccessDurationMs: number | null = null;
    for (const r of rows) {
      const n = Number(r.c);
      switch (r.result_category) {
        case 'success':
          success = n;
          avgSuccessDurationMs = r.avg_dur !== null ? Math.round(Number(r.avg_dur)) : null;
          break;
        case 'invalid': invalid = n; break;
        case 'fail': fail = n; break;
        case 'exception': exception = n; break;
        default:
          // Pre-stat-category rows (or null) bucket as fail — they were 4xx/5xx errors.
          // Only non-success rows have null category; success rows are 'success'.
          if (n > 0) invalid += n;
      }
    }
    const errorTotal = invalid + fail + exception;
    const total = success + errorTotal;
    return { success, invalid, fail, exception, errorTotal, total, avgSuccessDurationMs };
  }

  private async getTrend7d(range: OverviewRange): Promise<TrendPoint[]> {
    const config = overviewRangeConfig(range);
    const rows = await this.mysql.query<
      Array<{ d: string | Date; result_category: string | null; c: number; avg_dur: number | null }>
    >(
      `SELECT ${config.bucketSql} AS d, result_category, COUNT(*) AS c, AVG(duration_ms) AS avg_dur
       FROM operation_logs
       WHERE ${config.whereSql}
         AND (${TOOL_ROUTE_FILTER})
       GROUP BY ${config.bucketSql}, result_category
       ORDER BY d`,
    );
    // Fill missing days with 0 so the chart has continuous axis.
    const byDay = new Map<string, TrendPoint>();
    for (const r of rows) {
      const date = config.unit === 'hour' ? toHourKey(r.d) : toDateKey(r.d);
      const point = byDay.get(date) ?? emptyTrendPoint(date);
      const n = Number(r.c);
      switch (r.result_category) {
        case 'success':
          point.success = n;
          point.avgSuccessDurationMs = r.avg_dur !== null ? Math.round(Number(r.avg_dur)) : null;
          break;
        case 'invalid':
          point.invalid = n;
          break;
        case 'fail':
          point.fail = n;
          break;
        case 'exception':
          point.exception = n;
          break;
        default:
          if (n > 0) point.invalid += n;
      }
      point.errorTotal = point.invalid + point.fail + point.exception;
      point.total = point.success + point.errorTotal;
      byDay.set(date, point);
    }
    const out: TrendPoint[] = [];
    for (let i = config.points - 1; i >= 0; i--) {
      const d = new Date();
      if (config.unit === 'hour') {
        d.setMinutes(0, 0, 0);
        d.setHours(d.getHours() - i);
      } else {
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - i);
      }
      const key = config.unit === 'hour' ? toHourKey(d) : toDateKey(d);
      out.push(byDay.get(key) ?? emptyTrendPoint(key));
    }
    return out;
  }

  async getApiKeys(): Promise<ApiKeyInfo[]> {
    const rows = await this.mysql.query<
      Array<{ key_id: string; key_hash: string; status: number; created_at: Date; last_used_at: Date | null }>
    >(`SELECT key_id, key_hash, status, created_at, last_used_at FROM api_keys ORDER BY created_at ASC`);
    const plaintext = this.apiKeys.getPlaintextKey();
    const plaintextHash = plaintext ? createHash('sha256').update(plaintext.trim()).digest('hex') : null;
    return rows.map((r) => ({
      keyId: r.key_id,
      key: r.status === 1 && plaintextHash && r.key_hash === plaintextHash ? plaintext : null,
      status: r.status,
      createdAt: toIso(r.created_at),
      lastUsedAt: r.last_used_at ? toIso(r.last_used_at) : null,
    })).sort((a, b) => {
      if (!!a.key !== !!b.key) return a.key ? -1 : 1;
      if (a.status !== b.status) return b.status - a.status;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  async getLogs(q: LogsQueryDto): Promise<Paged<LogEntry>> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const { where, params } = buildLogsWhere(q);
    const totalRows = await this.mysql.query<Array<{ c: number }>>(
      `SELECT COUNT(*) AS c FROM operation_logs ${where}`,
      params,
    );
    const total = Number(totalRows[0]?.c ?? 0);
    const rows = await this.mysql.query<LogRow[]>(
      `SELECT id, log_type, operator, method, endpoint, feature, file_info, status_code, level, result, result_category, action, target, duration_ms, message, created_at
       FROM operation_logs ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return { items: rows.map(mapLog), total, page, pageSize };
  }

  async getLog(id: number): Promise<LogEntry | null> {
    const rows = await this.mysql.query<LogRow[]>(
      `SELECT id, log_type, operator, method, endpoint, feature, file_info, status_code, level, result, result_category, action, target, duration_ms, message, stack, created_at
       FROM operation_logs WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ? mapLog(rows[0]) : null;
  }

  /** All matching rows (no pagination) for CSV export. Bounded by time range + a 10k cap. */
  async getLogsForExport(q: LogsQueryDto): Promise<LogEntry[]> {
    const { where, params } = buildLogsWhere(q);
    const rows = await this.mysql.query<LogRow[]>(
      `SELECT id, log_type, operator, method, endpoint, feature, file_info, status_code, level, result, result_category, action, target, duration_ms, message, created_at
       FROM operation_logs ${where}
       ORDER BY created_at DESC LIMIT 10000`,
      params,
    );
    return rows.map(mapLog);
  }

  async getLoginRecords(page: number, pageSize: number): Promise<Paged<LoginRecord>> {
    const totalRows = await this.mysql.query<Array<{ c: number }>>(
      `SELECT COUNT(*) AS c FROM login_records`,
      [],
    );
    const total = Number(totalRows[0]?.c ?? 0);
    const rows = await this.mysql.query<LoginRecordRow[]>(
      `SELECT id, username, result, reason, ip, user_agent, created_at
       FROM login_records ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [pageSize, (page - 1) * pageSize],
    );
    return { items: rows.map(mapLoginRecord), total, page, pageSize };
  }

  async getVersion(): Promise<VersionInfo> {
    const status = await this.updateCheck.getStatus(SERVER_VERSION);
    return {
      current: status.current,
      latest: status.latest,
      updateAvailable: status.updateAvailable,
      releasedAt: status.releasedAt,
      changelogUrl: status.changelogUrl,
      image: status.image,
    };
  }

  async updateUsername(userId: number, newUsername: string): Promise<void> {
    try {
      await this.mysql.execute('UPDATE users SET username = ? WHERE id = ?', [newUsername, userId]);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'ER_DUP_ENTRY') {
        throw new ConflictException({ code: 'CONFLICT', message: 'username already taken' });
      }
      throw err;
    }
  }

  /** Best-effort user_action audit row. Never throws. */
  async recordUserAction(
    operator: string,
    action: string,
    target: string | null,
    detail: string,
  ): Promise<void> {
    await this.mysql
      .execute(
        `INSERT INTO operation_logs (log_type, operator, level, result, result_category, action, target, message)
         VALUES ('user_action', ?, 'INFO', 'success', 'success', ?, ?, ?)`,
        [operator, action, target, detail],
      )
      .catch((err: Error) => this.logger.warn(`user_action log failed: ${err.message}`));
  }
}

interface LogRow {
  id: number;
  log_type: string;
  operator: string | null;
  method: string | null;
  endpoint: string | null;
  feature: string | null;
  file_info: string | null;
  status_code: number | null;
  level: string;
  result: string | null;
  result_category: string | null;
  action: string | null;
  target: string | null;
  duration_ms: number | null;
  message: string | null;
  stack?: string | null;
  created_at: Date;
}

interface LoginRecordRow {
  id: number;
  username: string;
  result: string;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

function mapLog(r: LogRow): LogEntry {
  return {
    id: r.id,
    logType: r.log_type,
    operator: r.operator,
    method: r.method,
    endpoint: r.endpoint,
    feature: r.feature,
    fileInfo: r.file_info,
    statusCode: r.status_code,
    level: r.level,
    result: r.result,
    resultCategory: r.result_category,
    action: r.action,
    target: r.target,
    durationMs: r.duration_ms,
    message: r.message,
    stack: r.stack,
    createdAt: toIso(r.created_at),
  };
}

function mapLoginRecord(r: LoginRecordRow): LoginRecord {
  return {
    id: r.id,
    username: r.username,
    result: r.result,
    reason: r.reason,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: toIso(r.created_at),
  };
}

function toIso(d: Date | string): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function emptyTrendPoint(date: string): TrendPoint {
  return {
    date,
    success: 0,
    invalid: 0,
    fail: 0,
    exception: 0,
    errorTotal: 0,
    total: 0,
    avgSuccessDurationMs: null,
  };
}

function toDateKey(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toHourKey(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 13).replace('T', ' ') + ':00';
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hour = String(value.getHours()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:00`;
}

function overviewRangeConfig(range: OverviewRange): {
  whereSql: string;
  bucketSql: string;
  points: number;
  unit: 'hour' | 'day';
} {
  switch (range) {
    case '24h':
      return {
        whereSql: 'created_at >= NOW() - INTERVAL 1 DAY',
        bucketSql: "DATE_FORMAT(created_at, '%Y-%m-%d %H:00')",
        points: 24,
        unit: 'hour',
      };
    case 'month':
      return {
        whereSql: 'created_at >= CURDATE() - INTERVAL 29 DAY',
        bucketSql: 'DATE(created_at)',
        points: 30,
        unit: 'day',
      };
    case 'week':
    default:
      return {
        whereSql: 'created_at >= CURDATE() - INTERVAL 6 DAY',
        bucketSql: 'DATE(created_at)',
        points: 7,
        unit: 'day',
      };
  }
}

// process.cwd() is the server root in both dev (server/) and prod (/app), where
// package.json lives. Read once at module load — version is display-only.
const SERVER_VERSION = readServerVersion();
function readServerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Build the WHERE clause + params for log filtering (list + export share this). */
function buildLogsWhere(q: LogsQueryDto): { where: string; params: Array<string | number> } {
  const conds: string[] = [];
  const params: Array<string | number> = [];
  if (q.level) { conds.push('level = ?'); params.push(q.level); }
  if (q.logType) { conds.push('log_type = ?'); params.push(q.logType); }
  if (q.operator) { conds.push('operator = ?'); params.push(q.operator); }
  // utf8mb4_unicode_ci (init.sql) makes LIKE case-insensitive by default.
  if (q.keyword) { conds.push('message LIKE ?'); params.push(`%${q.keyword}%`); }
  const range = timeRangeCondition(q);
  if (range) { conds.push(range.sql); params.push(...range.params); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return { where, params };
}

function timeRangeCondition(q: LogsQueryDto): { sql: string; params: Array<string | number> } | null {
  const range = q.timeRange ?? '1h';
  if (range === 'custom') {
    if (q.startTime && q.endTime) {
      return { sql: 'created_at >= ? AND created_at <= ?', params: [q.startTime, q.endTime] };
    }
    return null; // custom without bounds → no time filter
  }
  const map: Record<string, string> = {
    '15m': '15 MINUTE', '1h': '1 HOUR', '6h': '6 HOUR', '24h': '24 HOUR',
  };
  const interval = map[range] ?? '1 HOUR';
  // INTERVAL N MINUTE is a literal — not parameterized — but `interval` comes
  // from a validated @IsIn enum, never user free-text, so injection-safe.
  return { sql: `created_at >= NOW() - INTERVAL ${interval}`, params: [] };
}
