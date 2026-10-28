import { BadRequestException, ConflictException, HttpException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RuntimeModeService } from '../runtime/runtime-mode.service';
import { TaskDrainService } from '../runtime/task-drain.service';
import { UpdaterClientService, UpdaterResponse } from './updater-client.service';
import { DashboardService } from './dashboard.service';

export interface LicenseUpdateStatus {
  requestId: string;
  phase: string;
  updatedAt: string;
  sha256?: string;
  error?: string;
}
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ROLLED_BACK']);

@Injectable()
export class LicenseUpdateService implements OnModuleInit, OnModuleDestroy {
  private job: LicenseUpdateStatus | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private draining = false;
  private readonly statePath: string;

  constructor(
    config: ConfigService,
    private readonly updater: UpdaterClientService,
    private readonly mode: RuntimeModeService,
    private readonly drain: TaskDrainService,
    private readonly audit: DashboardService,
  ) {
    const directory = config.get<string>('storageDir') ?? 'storage';
    mkdirSync(directory, { recursive: true });
    this.statePath = join(directory, 'license-update.json');
    if (existsSync(this.statePath)) {
      // Invalid persisted state must not silently unlock maintenance.
      this.job = JSON.parse(readFileSync(this.statePath, 'utf8')) as LicenseUpdateStatus;
    }
  }

  onModuleInit() {
    this.timer = setInterval(() => { void this.reconcile().catch(() => undefined); }, 2000);
    this.timer.unref();
    void this.reconcile().catch(() => undefined);
  }
  onModuleDestroy() { clearInterval(this.timer); }

  private save(job: LicenseUpdateStatus) {
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
    renameSync(temporary, this.statePath);
    this.job = job;
  }
  private state(phase: string, error?: string) {
    this.save({ ...this.job!, phase, error, updatedAt: new Date().toISOString() });
  }

  async status() {
    await this.reconcile();
    return this.job;
  }

  async start(file: Express.Multer.File | undefined, approve: string, operator: string) {
    if (approve !== 'true' || !file || !/^license[^/\\]*\.xml$/i.test(file.originalname)
      || file.size === 0 || file.size > 65536) {
      throw new BadRequestException('Select a license XML file (maximum 64 KiB) and confirm the restart.');
    }
    // Readiness check before taking maintenance ownership; only the updater touches Docker.
    unwrap(await this.updater.get('/v1/license'));
    if (this.mode.getState().mode !== 'normal' || (this.job && !TERMINAL.has(this.job.phase))) {
      throw new ConflictException('Another maintenance operation is active.');
    }
    const requestId = `license-${randomUUID()}`;
    this.save({ requestId, phase: 'DRAINING', updatedAt: new Date().toISOString() });
    this.mode.setMode('draining', { requestId, operator, reason: 'Runtime license replacement' });
    this.draining = true;
    void this.run(file.buffer, operator).catch(() => {
      // A lost response may follow an accepted operation. Reconciliation owns recovery.
    }).finally(() => { this.draining = false; });
    return this.job;
  }

  private async run(xml: Buffer, operator: string) {
    try {
      const drained = await this.drain.waitForDrain({ timeoutMs: 60_000 });
      if (!drained.drained) throw new Error('Active tasks did not drain within 60 seconds; license was not changed.');
      if (this.mode.getState().requestId !== this.job!.requestId) throw new Error('Maintenance ownership changed; license was not changed.');
    } catch (err) {
      this.state('FAILED', err instanceof Error ? err.message : 'Task drain failed.');
      this.releaseMaintenance();
      return;
    }
    this.mode.setMode('maintenance', { requestId: this.job!.requestId, operator, reason: 'Replacing runtime license and restarting compdf-app' });
    this.state('DISPATCHING');
    const response = await this.updater.post<LicenseUpdateStatus>('/v1/license', {
      requestId: this.job!.requestId, xml: xml.toString('base64'), approve: true, maintenanceConfirmed: true,
    });
    if (response.statusCode >= 400 || response.body.exitCode !== 0) {
      this.state('FAILED', response.body.error ?? 'Updater rejected license update.');
      this.releaseMaintenance();
      return;
    }
    this.save(unwrap(response));
    await this.audit.recordUserAction(operator, 'update_runtime_license', this.job!.requestId, 'Runtime license update accepted; license contents omitted.');
  }

  async recover(operator: string) {
    await this.reconcile();
    if (!this.job || this.job.phase !== 'RECOVERY_REQUIRED' || this.mode.getState().requestId !== this.job.requestId) {
      throw new ConflictException('No matching license recovery is available.');
    }
    const response = await this.updater.post<LicenseUpdateStatus>('/v1/license/recover', {
      requestId: this.job.requestId, approve: true, maintenanceConfirmed: true,
    });
    this.save(unwrap(response));
    await this.audit.recordUserAction(operator, 'recover_runtime_license', this.job.requestId, 'Previous runtime license recovery requested.');
    return this.job;
  }

  private async reconcile() {
    if (this.checking || !this.job) return;
    if (TERMINAL.has(this.job.phase)) { this.releaseMaintenance(); return; }
    if (this.draining) return;
    this.checking = true;
    try {
      if (this.job.phase === 'DRAINING') {
        this.state('FAILED', 'Server restarted before license replacement; license was not changed.');
        this.releaseMaintenance(); return;
      }
      const status = unwrap(await this.updater.get<LicenseUpdateStatus>('/v1/license'));
      if (status.requestId !== this.job.requestId) {
        // Do not guess whether a timed-out POST may still arrive. Fail closed.
        throw new ConflictException('License operation status is unavailable; maintenance remains active.');
      }
      const changed = status.phase !== this.job.phase;
      this.save(status);
      if (TERMINAL.has(status.phase)) {
        this.releaseMaintenance();
        if (changed) await this.audit.recordUserAction('system', 'runtime_license_result', status.requestId, `License operation ${status.phase}; SHA256=${status.sha256 ?? ''}.`);
      }
    } finally { this.checking = false; }
  }

  private releaseMaintenance() {
    const current = this.mode.getState();
    if (this.job && TERMINAL.has(this.job.phase) && current.requestId === this.job.requestId && current.mode !== 'normal') {
      this.mode.setMode('normal', { requestId: this.job.requestId, operator: 'system', reason: `License operation ${this.job.phase}` });
    }
  }
}

function unwrap<T>(response: UpdaterResponse<T>): T {
  if (response.statusCode >= 400 || response.body.exitCode !== 0 || !response.body.result) {
    throw new HttpException(response.body.error ?? 'License updater unavailable.', response.statusCode >= 400 ? response.statusCode : 502);
  }
  return response.body.result;
}
