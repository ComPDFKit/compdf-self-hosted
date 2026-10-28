import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export type RuntimeMode = 'normal' | 'draining' | 'maintenance';

export interface RuntimeModeState {
  schemaVersion: 1;
  revision: number;
  mode: RuntimeMode;
  operator: string;
  requestId: string;
  reason: string;
  updatedAt: string;
}

export interface RuntimeModeChange {
  operator: string;
  requestId: string;
  reason: string;
}

const STATE_FILE = 'runtime-mode.json';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

@Injectable()
export class RuntimeModeService {
  private readonly logger = new Logger(RuntimeModeService.name);
  private readonly statePath: string;
  private state: RuntimeModeState;
  private activeRequests = 0;

  beginProcessingRequest(): () => void {
    this.activeRequests++;
    let finished = false;
    return () => { if (!finished) { finished = true; this.activeRequests--; } };
  }

  getActiveProcessingRequests(): number { return this.activeRequests; }

  constructor(config: ConfigService) {
    const storageDir = config.get<string>('storageDir') ?? 'storage';
    this.statePath = join(storageDir, STATE_FILE);
    this.state = this.loadOrInitialize();
  }

  getState(): RuntimeModeState {
    return { ...this.state };
  }

  isAcceptingNewWork(): boolean {
    return this.state.mode === 'normal';
  }

  setMode(mode: RuntimeMode, change: RuntimeModeChange): RuntimeModeState {
    if (!isRuntimeMode(mode)) throw new Error(`unsupported runtime mode: ${mode}`);
    const operator = change.operator.trim();
    const requestId = change.requestId.trim();
    const reason = change.reason.trim();
    if (!operator || !REQUEST_ID_PATTERN.test(requestId) || !reason) {
      throw new Error('operator, a safe requestId, and reason are required');
    }
    if (operator.length > 50 || requestId.length > 128 || reason.length > 1000) {
      throw new Error('runtime mode change metadata is too long');
    }
    const next: RuntimeModeState = {
      schemaVersion: 1,
      revision: this.state.revision + 1,
      mode,
      operator,
      requestId,
      reason,
      updatedAt: new Date().toISOString(),
    };
    this.persist(next);
    this.state = next;
    return this.getState();
  }

  private loadOrInitialize(): RuntimeModeState {
    try {
      if (!existsSync(this.statePath)) {
        const initial: RuntimeModeState = {
          schemaVersion: 1,
          revision: 1,
          mode: 'normal',
          operator: 'system',
          requestId: 'initial-startup',
          reason: 'runtime mode initialized',
          updatedAt: new Date().toISOString(),
        };
        this.persist(initial);
        return initial;
      }
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown;
      if (!isRuntimeModeState(parsed)) throw new Error('state file has an invalid schema');
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`runtime mode state is unavailable; failing closed: ${message}`);
      return {
        schemaVersion: 1,
        revision: 0,
        mode: 'maintenance',
        operator: 'system',
        requestId: 'startup-recovery',
        reason: 'runtime mode state could not be loaded',
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private persist(state: RuntimeModeState): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.statePath);
  }
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === 'normal' || value === 'draining' || value === 'maintenance';
}

function isRuntimeModeState(value: unknown): value is RuntimeModeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<RuntimeModeState>;
  return state.schemaVersion === 1
    && Number.isInteger(state.revision)
    && (state.revision ?? 0) > 0
    && isRuntimeMode(state.mode)
    && typeof state.operator === 'string'
    && typeof state.requestId === 'string'
    && typeof state.reason === 'string'
    && typeof state.updatedAt === 'string'
    && !Number.isNaN(Date.parse(state.updatedAt));
}
