/**
 * DashboardController — admin Dashboard API (api/v1/dashboard/*).
 *
 * All routes require a valid admin JWT (JwtAuthGuard stamps req.user:
 * AdminPayload { sub, username, role }). Reads aggregate from
 * operation_logs/login_records/api_keys + license display. Mutating routes
 * (settings, logo, account) also write a best-effort user_action log row.
 *
 * Public sibling: BrandingController serves the logo WITHOUT auth (both SPAs
 * need it pre-login) at api/v1/dashboard/branding/logo.
 *
 * Change-password is NOT here — it stays at POST /api/v1/auth/change-password
 * (existing). The Account page calls that endpoint directly.
 */
import {
  BadRequestException, Body, Controller, Get, HttpException, NotFoundException, Param, Patch,
  Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { join } from 'path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { JwtAuthGuard, AdminPayload } from '../auth/guards/jwt-auth.guard';
import { AuthService, RefreshedSession } from '../auth/auth.service';
import { contentDispositionAttachment } from '../common/utils/filename';
import { BrandSettingsService } from './brand-settings.service';
import { DashboardService } from './dashboard.service';
import { SystemLogService } from './system-log.service';
import {
  ApiKeyActionDto, ClientErrorDto, LogEntry, LogsQueryDto, OverviewQueryDto, PaginationDto, UpdateAccountDto, UpdateApplyDto, UpdateBackupDto, UpdateCancelDto, UpdateCheckDto, UpdateJobDto, UpdateRollbackDto, UpdateRuntimeModeDto, UpdateSettingsDto,
} from './dashboard.dto';
import { RuntimeModeService } from '../runtime/runtime-mode.service';
import { TaskDrainService } from '../runtime/task-drain.service';
import { UpdaterClientService, UpdaterResponse } from './updater-client.service';

@Controller('api/v1/dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  private readonly storageDir: string;

  constructor(
    private readonly dashboard: DashboardService,
    private readonly brands: BrandSettingsService,
    private readonly systemLog: SystemLogService,
    config: ConfigService,
    private readonly auth: AuthService,
    private readonly runtimeMode: RuntimeModeService,
    private readonly taskDrain: TaskDrainService,
    private readonly updater: UpdaterClientService,
  ) {
    this.storageDir = config.get<string>('storageDir') ?? 'storage';
  }

  @Get('runtime-mode')
  async getRuntimeMode() {
    return {
      state: this.runtimeMode.getState(),
      tasks: await this.taskDrain.getSnapshot(),
    };
  }

  @Put('runtime-mode')
  async updateRuntimeMode(@Body() dto: UpdateRuntimeModeDto, @Req() req: Request & { user: AdminPayload }) {
    const state = this.runtimeMode.setMode(dto.mode, {
      operator: req.user.username,
      requestId: dto.requestId,
      reason: dto.reason,
    });
    await this.dashboard.recordUserAction(
      req.user.username,
      'update_runtime_mode',
      dto.mode,
      `Changed runtime mode to ${dto.mode}; requestId=${dto.requestId}.`,
    );
    return { state, tasks: await this.taskDrain.getSnapshot() };
  }

  @Get('update/current')
  async getUpdateStatus() {
    return unwrapUpdater(await this.updater.get('/v1/status'));
  }

  @Get('update/history')
  async getUpdateHistory() {
    return unwrapUpdater(await this.updater.get('/v1/history'));
  }

  @Get('update/automation')
  async getUpdateAutomation() {
    return unwrapUpdater(await this.updater.get('/v1/automation'));
  }

  @Post('update/check')
  async checkForUpdate(@Body() dto: UpdateCheckDto, @Req() req: Request & { user: AdminPayload }) {
    return this.executeUpdaterAction(req.user.username, 'update_check', dto.currentVersion, this.updater.post('/v1/check', dto));
  }

  @Post('update/download')
  async downloadUpdate(@Body() dto: UpdateJobDto, @Req() req: Request & { user: AdminPayload }) {
    return this.executeUpdaterAction(req.user.username, 'update_download', dto.targetVersion, this.updater.post('/v1/download', dto, 30 * 60_000));
  }

  @Post('update/cancel')
  async cancelUpdate(@Body() dto: UpdateCancelDto, @Req() req: Request & { user: AdminPayload }) {
    return this.executeUpdaterAction(req.user.username, 'update_cancel', dto.requestId, this.updater.post('/v1/cancel', dto));
  }

  @Post('update/preflight')
  async preflightUpdate(@Body() dto: UpdateJobDto, @Req() req: Request & { user: AdminPayload }) {
    const response = await this.updater.post('/v1/preflight', dto);
    if (response.body.exitCode === 3 && response.body.result) return response.body.result;
    return this.executeUpdaterAction(req.user.username, 'update_preflight', dto.targetVersion, Promise.resolve(response));
  }

  @Post('update/backup')
  async backupForUpdate(@Body() dto: UpdateBackupDto, @Req() req: Request & { user: AdminPayload }) {
    return this.executeUpdaterAction(req.user.username, 'update_backup', dto.requestId, this.updater.post('/v1/backup', dto, 120_000));
  }

  @Post('update/apply')
  async applyUpdate(@Body() dto: UpdateApplyDto, @Req() req: Request & { user: AdminPayload }) {
    return this.executeUpdaterAction(req.user.username, 'update_apply', dto.targetVersion, this.updater.post('/v1/apply', dto, 15 * 60_000));
  }

  @Post('update/rollback')
  async rollbackUpdate(@Body() dto: UpdateRollbackDto, @Req() req: Request & { user: AdminPayload }) {
    return this.executeUpdaterAction(req.user.username, 'update_rollback', dto.requestId, this.updater.post('/v1/rollback', dto, 15 * 60_000));
  }

  @Get('overview')
  overview(@Query() q: OverviewQueryDto) {
    return this.dashboard.getOverview(q.range ?? 'week');
  }

  @Get('logs')
  logs(@Query() q: LogsQueryDto) {
    return this.dashboard.getLogs(q);
  }

  @Get('logs/export')
  async exportLogs(@Query() q: LogsQueryDto, @Res() res: Response, @Req() req: Request & { user: AdminPayload }): Promise<void> {
    const rows = await this.dashboard.getLogsForExport(q);
    const csv = toCsv(rows);
    await this.dashboard.recordUserAction(
      req.user.username,
      'export_logs',
      `logs:${q.logType ?? 'all'}/${q.level ?? 'all'}/${q.timeRange ?? '1h'}`,
      `Exported ${rows.length} log rows with filters: type=${q.logType ?? 'all'}, level=${q.level ?? 'all'}, range=${q.timeRange ?? '1h'}.`,
    );
    // BOM so Excel reads UTF-8 (logs contain CJK).
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', contentDispositionAttachment('operation-logs.csv'));
    res.status(200).send('﻿' + csv);
  }

  @Post('logs/client-error')
  async reportClientError(@Body() dto: ClientErrorDto, @Req() req: Request & { user: AdminPayload }): Promise<{ ok: true }> {
    await this.systemLog.recordError('client_error', dto.message, {
      stack: dto.stack ?? null,
      target: dto.context ?? null,
      category: 'fail',
    });
    return { ok: true };
  }

  @Get('logs/:id')
  async logDetail(@Param('id') id: string) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'invalid log id' });
    }
    const entry = await this.dashboard.getLog(n);
    if (!entry) throw new NotFoundException({ code: 'NOT_FOUND', message: 'log not found' });
    return entry;
  }

  @Get('login-records')
  loginRecords(@Query() q: PaginationDto) {
    return this.dashboard.getLoginRecords(q.page ?? 1, q.pageSize ?? 20);
  }

  @Get('api-keys')
  apiKeys() {
    return this.dashboard.getApiKeys();
  }

  @Post('api-keys/actions')
  async recordApiKeyAction(@Body() dto: ApiKeyActionDto, @Req() req: Request & { user: AdminPayload }): Promise<{ ok: true }> {
    await this.dashboard.recordApiKeyAction(req.user.username, dto);
    return { ok: true };
  }

  @Get('version')
  version() {
    return this.dashboard.getVersion();
  }

  @Patch('account')
  async updateAccount(@Body() dto: UpdateAccountDto, @Req() req: Request & { user: AdminPayload }): Promise<RefreshedSession> {
    if (dto.username && dto.username !== req.user.username) {
      await this.dashboard.updateUsername(req.user.sub, dto.username);
      await this.dashboard.recordUserAction(
        req.user.username,
        'update_username',
        dto.username,
        `Changed username from "${req.user.username}" to "${dto.username}".`,
      );
    }
    return this.auth.refreshSession(req.user, dto.username ?? req.user.username);
  }

  @Post('account/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
          return cb(new BadRequestException({ code: 'VALIDATION_ERROR', message: 'avatar must be PNG, JPEG, or WebP' }), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadAvatar(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request & { user: AdminPayload },
  ): Promise<{ avatarUrl: string | null }> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'avatar file is required' });
    }
    const ext = avatarExtension(file.mimetype);
    const filename = `${req.user.sub}.${ext}`;
    const avatarDir = join(this.storageDir, 'avatars');
    mkdirSync(avatarDir, { recursive: true });
    const previous = await this.dashboard.getAvatarPath(req.user.sub);
    if (previous && previous !== filename) {
      try { unlinkSync(join(avatarDir, previous)); } catch { /* best-effort */ }
    }
    writeFileSync(join(avatarDir, filename), file.buffer);
    await this.dashboard.updateAvatarPath(req.user.sub, filename);
    await this.dashboard.recordUserAction(
      req.user.username,
      'update_avatar',
      filename,
      'Updated profile avatar.',
    );
    return { avatarUrl: this.auth.getAvatarDataUrl(filename) };
  }

  @Get('settings')
  getSettings() {
    return this.brands.getSettings();
  }

  @Put('settings')
  async updateSettings(@Body() dto: UpdateSettingsDto, @Req() req: Request & { user: AdminPayload }) {
    const updated = await this.brands.updateSettings(dto);
    const keys = Object.keys(dto).join(',') || '(noop)';
    await this.dashboard.recordUserAction(
      req.user.username,
      'update_settings',
      keys,
      settingsSummary(dto),
    );
    return updated;
  }

  @Post('settings/logo')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!['image/png', 'image/svg+xml'].includes(file.mimetype)) {
          return cb(new BadRequestException({ code: 'VALIDATION_ERROR', message: 'logo must be PNG or SVG' }), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadLogo(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request & { user: AdminPayload },
  ) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'logo file is required' });
    }
    const ext = file.mimetype === 'image/svg+xml' ? 'svg' : 'png';
    const filename = `logo.${ext}`;
    const brandingDir = join(this.storageDir, 'branding');
    mkdirSync(brandingDir, { recursive: true });
    // Remove a previous logo whose extension differs (e.g. swapping png → svg).
    const prev = await this.brands.getSettings();
    if (prev.logoPath && prev.logoPath !== filename && existsSync(join(brandingDir, prev.logoPath))) {
      try { unlinkSync(join(brandingDir, prev.logoPath)); } catch { /* best-effort */ }
    }
    writeFileSync(join(brandingDir, filename), file.buffer);
    const updated = await this.brands.updateLogo(filename);
    await this.dashboard.recordUserAction(
      req.user.username,
      'upload_logo',
      filename,
      `Uploaded branding logo "${filename}".`,
    );
    return updated;
  }

  private async executeUpdaterAction<T>(
    operator: string,
    action: string,
    target: string,
    operation: Promise<UpdaterResponse<T>>,
  ): Promise<T | null> {
    const result = unwrapUpdater(await operation);
    await this.dashboard.recordUserAction(operator, action, target, `Updater action ${action} completed for ${target}.`);
    return result;
  }
}

function settingsSummary(dto: UpdateSettingsDto): string {
  const entries = Object.entries(dto)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  if (entries.length === 0) return 'Updated settings with no field changes.';
  return `Updated settings: ${entries.join(', ')}.`;
}

function avatarExtension(mimetype: string): 'png' | 'jpg' | 'webp' {
  if (mimetype === 'image/jpeg') return 'jpg';
  if (mimetype === 'image/webp') return 'webp';
  return 'png';
}

/** Minimal RFC-4180 CSV encoder: quote fields containing comma/quote/newline. */
function toCsv(rows: LogEntry[]): string {
  const headers: Array<keyof LogEntry> = [
    'id', 'logType', 'operator', 'method', 'endpoint', 'feature', 'fileInfo',
    'statusCode', 'level', 'result', 'resultCategory', 'action', 'target',
    'durationMs', 'message', 'createdAt',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvField(r[h])).join(','));
  }
  return lines.join('\n');
}

function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function unwrapUpdater<T>(response: UpdaterResponse<T>): T | null {
  if (response.statusCode >= 400 || response.body.exitCode !== 0) {
    throw new HttpException({
      code: 'UPDATER_OPERATION_FAILED',
      message: response.body.error ?? 'Updater operation failed.',
      updaterExitCode: response.body.exitCode,
      result: response.body.result ?? null,
    }, response.statusCode >= 400 ? response.statusCode : 409);
  }
  return response.body.result ?? null;
}
