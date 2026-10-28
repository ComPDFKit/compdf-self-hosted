/**
 * dashboard.dto.ts — request DTOs + response shapes for the Dashboard API.
 *
 * Request DTOs are validated by the global ValidationPipe (whitelist + transform
 * in AppModule). Response interfaces are returned verbatim as JSON — the
 * AllExceptionsFilter only reshapes errors, never successes.
 */
import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max, MinLength,
} from 'class-validator';

// --- Request DTOs ---

export type LogTimeRange = '15m' | '1h' | '6h' | '24h' | 'custom';
export type LogType = 'user_action' | 'api_call' | 'error' | 'system';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
export type OverviewRange = '24h' | 'week' | 'month';

export class OverviewQueryDto {
  @IsOptional() @IsIn(['24h', 'week', 'month'])
  range?: OverviewRange = 'week';
}

export class LogsQueryDto {
  @IsOptional() @IsIn(['INFO', 'WARN', 'ERROR', 'FATAL'])
  level?: LogLevel;

  @IsOptional() @IsIn(['user_action', 'api_call', 'error', 'system'])
  logType?: LogType;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  keyword?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(50)
  operator?: string;

  @IsOptional() @IsIn(['15m', '1h', '6h', '24h', 'custom'])
  timeRange?: LogTimeRange = '1h';

  /** ISO 8601 — used only when timeRange='custom'. */
  @IsOptional() @IsString()
  startTime?: string;

  /** ISO 8601 — used only when timeRange='custom'. */
  @IsOptional() @IsString()
  endTime?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number = 20;
}

export class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number = 20;
}

export class UpdateAccountDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(50)
  username?: string;
}

export class ApiKeyActionDto {
  @IsString() @MinLength(1) @MaxLength(32)
  keyId!: string;

  @IsIn(['view', 'copy'])
  action!: 'view' | 'copy';
}

export class ClientErrorDto {
  @IsString() @MinLength(1) @MaxLength(1000)
  message!: string;

  @IsOptional() @IsString() @MaxLength(4000)
  stack?: string;

  /** Free-form context: route path, component name, etc. */
  @IsOptional() @IsString() @MaxLength(255)
  context?: string;
}

export class UpdateSettingsDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  siteName?: string;

  @IsOptional() @IsString() @MaxLength(20)
  themeColor?: string;

  @IsOptional() @IsBoolean()
  darkMode?: boolean;

  /** Empty string clears the field (stored as NULL). */
  @IsOptional() @IsString() @MaxLength(255)
  upgradeBannerText?: string;

  @IsOptional() @IsString() @MaxLength(255)
  docUrl?: string;

  @IsOptional() @IsString() @MaxLength(255)
  contactUrl?: string;

}

export class UpdateRuntimeModeDto {
  @IsIn(['normal', 'draining', 'maintenance'])
  mode!: 'normal' | 'draining' | 'maintenance';

  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  requestId!: string;

  @IsString() @MinLength(1) @MaxLength(1000)
  reason!: string;
}

export class UpdateCheckDto {
  @IsString() @Matches(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  currentVersion!: string;
}

export class UpdateJobDto extends UpdateCheckDto {
  @IsString() @Matches(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  targetVersion!: string;

  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/)
  requestId!: string;
}

export class UpdateBackupDto extends UpdateCheckDto {
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/)
  requestId!: string;

  @IsBoolean()
  approve!: boolean;

  @IsBoolean()
  maintenanceConfirmed!: boolean;
}

export class UpdateApplyDto extends UpdateJobDto {
  @IsBoolean()
  approve!: boolean;

  @IsBoolean()
  maintenanceConfirmed!: boolean;

  @IsOptional() @IsBoolean()
  offlineRiskConfirmed?: boolean;
}

export class UpdateRollbackDto {
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/)
  requestId!: string;

  @IsBoolean()
  approve!: boolean;
}

export class UpdateCancelDto {
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/)
  requestId!: string;
}

// --- Response shapes ---

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
  /** Only present on the detail endpoint (not the list). */
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
  errorTotal: number;                   // invalid + fail + exception
  total: number;                        // success + errorTotal
  avgSuccessDurationMs: number | null;  // null when no success calls today
}

export interface TrendPoint extends OverviewToday {
  date: string;
}

export interface Overview {
  today: OverviewToday;
  trend7d: TrendPoint[];
  apiKeys: ApiKeyInfo[];
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
