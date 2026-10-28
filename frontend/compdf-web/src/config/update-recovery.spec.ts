// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import type { UpdateJob } from '@/api/dashboard';
import {
  clearPendingUpdateOperation,
  createPendingUpdateOperation,
  loadPendingUpdateOperation,
  savePendingUpdateOperation,
  updateOperationOutcome,
} from './update-recovery';

function job(phase: UpdateJob['phase'], requestId = 'request-1'): UpdateJob {
  return {
    requestId,
    currentVersion: '4.1.1',
    targetVersion: '5.0.0',
    delivery: 'online',
    phase,
    revision: 1,
    updatedAt: new Date().toISOString(),
    events: [],
  };
}

describe('update operation recovery', () => {
  beforeEach(() => localStorage.clear());

  it('persists and restores an approved operation', () => {
    const operation = createPendingUpdateOperation('install', 'request-1', '4.1.1', '5.0.0', 1000);
    savePendingUpdateOperation(operation);
    expect(loadPendingUpdateOperation()).toEqual(operation);
    clearPendingUpdateOperation();
    expect(loadPendingUpdateOperation()).toBeNull();
  });

  it('rejects malformed persisted data', () => {
    localStorage.setItem('compdf-pending-update-operation', '{"action":"install"}');
    expect(loadPendingUpdateOperation()).toBeNull();
  });

  it('recognizes install and rollback terminal outcomes', () => {
    const install = createPendingUpdateOperation('install', 'request-1', '4.1.1', '5.0.0');
    const rollback = createPendingUpdateOperation('rollback', 'request-1', '4.1.1', '5.0.0');
    expect(updateOperationOutcome(install, job('COMMITTED'))).toBe('succeeded');
    expect(updateOperationOutcome(install, job('ROLLBACK_REQUIRED'))).toBe('failed');
    expect(updateOperationOutcome(rollback, job('ROLLBACK_REQUIRED'))).toBe('pending');
    expect(updateOperationOutcome(rollback, job('ROLLED_BACK'))).toBe('succeeded');
    expect(updateOperationOutcome(rollback, job('ROLLED_BACK', 'another-request'))).toBe('pending');
  });
});
