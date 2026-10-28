import { ConfigService } from '@nestjs/config';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { RuntimeModeService } from './runtime-mode.service';

function configFor(storageDir: string): ConfigService {
  return { get: (key: string) => key === 'storageDir' ? storageDir : undefined } as ConfigService;
}

describe('RuntimeModeService', () => {
  it('persists mode and audit metadata across service recreation', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'compdf-runtime-mode-'));
    const service = new RuntimeModeService(configFor(storageDir));
    const changed = service.setMode('draining', {
      operator: 'admin',
      requestId: 'upgrade-42',
      reason: 'prepare for upgrade',
    });

    const restored = new RuntimeModeService(configFor(storageDir)).getState();
    expect(restored).toEqual(changed);
    expect(restored.mode).toBe('draining');
    expect(restored.revision).toBe(2);
  });

  it('fails closed when the persisted state is invalid', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'compdf-runtime-mode-invalid-'));
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(join(storageDir, 'runtime-mode.json'), '{"mode":"unknown"}\n');

    const state = new RuntimeModeService(configFor(storageDir)).getState();
    expect(state.mode).toBe('maintenance');
    expect(state.requestId).toBe('startup-recovery');

    const recovered = new RuntimeModeService(configFor(storageDir));
    expect(recovered.setMode('normal', {
      operator: 'admin',
      requestId: 'recovery-1',
      reason: 'state inspected and recovered',
    }).mode).toBe('normal');
    expect(new RuntimeModeService(configFor(storageDir)).getState().mode).toBe('normal');
  });
});
