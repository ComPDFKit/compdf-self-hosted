import type { UpdateJob } from '@/api/dashboard';

export type UpdateOperationAction = 'install' | 'rollback';

export interface PendingUpdateOperation {
  schemaVersion: 1;
  action: UpdateOperationAction;
  requestId: string;
  currentVersion: string;
  targetVersion: string;
  startedAt: number;
  deadlineAt: number;
}

export type UpdateOperationOutcome = 'pending' | 'succeeded' | 'failed';

const STORAGE_KEY = 'compdf-pending-update-operation';
export const UPDATE_OPERATION_TIMEOUT_MS = 15 * 60_000;

export function createPendingUpdateOperation(
  action: UpdateOperationAction,
  requestId: string,
  currentVersion: string,
  targetVersion: string,
  now = Date.now(),
): PendingUpdateOperation {
  return {
    schemaVersion: 1,
    action,
    requestId,
    currentVersion,
    targetVersion,
    startedAt: now,
    deadlineAt: now + UPDATE_OPERATION_TIMEOUT_MS,
  };
}

export function loadPendingUpdateOperation(storage: Pick<Storage, 'getItem'> = localStorage): PendingUpdateOperation | null {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Partial<PendingUpdateOperation> | null;
    if (!value || value.schemaVersion !== 1 || (value.action !== 'install' && value.action !== 'rollback')) return null;
    if (!value.requestId || !value.currentVersion || !value.targetVersion) return null;
    if (!Number.isFinite(value.startedAt) || !Number.isFinite(value.deadlineAt)) return null;
    return value as PendingUpdateOperation;
  } catch {
    return null;
  }
}

export function savePendingUpdateOperation(
  operation: PendingUpdateOperation,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(operation));
}

export function clearPendingUpdateOperation(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  storage.removeItem(STORAGE_KEY);
}

export function updateOperationOutcome(operation: PendingUpdateOperation, job: UpdateJob | null): UpdateOperationOutcome {
  if (!job || job.requestId !== operation.requestId) return 'pending';
  if (operation.action === 'install') {
    if (job.phase === 'COMMITTED') return 'succeeded';
    if (job.phase === 'FAILED' || job.phase === 'ROLLBACK_REQUIRED' || job.phase === 'ROLLED_BACK') return 'failed';
    return 'pending';
  }
  if (job.phase === 'ROLLED_BACK') return 'succeeded';
  if (job.phase === 'FAILED') return 'failed';
  return 'pending';
}
