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
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch,
  Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { join } from 'path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { JwtAuthGuard, AdminPayload } from '../auth/guards/jwt-auth.guard';
import { contentDispositionAttachment } from '../common/utils/filename';
import { BrandSettingsService } from './brand-settings.service';
import { DashboardService } from './dashboard.service';
import { SystemLogService } from './system-log.service';
import {
  ClientErrorDto, LogEntry, LogsQueryDto, OverviewQueryDto, PaginationDto, UpdateAccountDto, UpdateSettingsDto,
} from './dashboard.dto';

@Controller('api/v1/dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  private readonly storageDir: string;

  constructor(
    private readonly dashboard: DashboardService,
    private readonly brands: BrandSettingsService,
    private readonly systemLog: SystemLogService,
    config: ConfigService,
  ) {
    this.storageDir = config.get<string>('storageDir') ?? 'storage';
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
      `export_logs: ${rows.length} rows`,
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

  @Get('version')
  version() {
    return this.dashboard.getVersion();
  }

  @Patch('account')
  async updateAccount(@Body() dto: UpdateAccountDto, @Req() req: Request & { user: AdminPayload }) {
    if (dto.username && dto.username !== req.user.username) {
      await this.dashboard.updateUsername(req.user.sub, dto.username);
      await this.dashboard.recordUserAction(req.user.username, 'update_username', dto.username, `→ ${dto.username}`);
    }
    return { ok: true };
  }

  @Get('settings')
  getSettings() {
    return this.brands.getSettings();
  }

  @Put('settings')
  async updateSettings(@Body() dto: UpdateSettingsDto, @Req() req: Request & { user: AdminPayload }) {
    const updated = await this.brands.updateSettings(dto);
    const keys = Object.keys(dto).join(',') || '(noop)';
    await this.dashboard.recordUserAction(req.user.username, 'update_settings', keys, JSON.stringify(dto));
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
    await this.dashboard.recordUserAction(req.user.username, 'upload_logo', filename, filename);
    return updated;
  }
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
