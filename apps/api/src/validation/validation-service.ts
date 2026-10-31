import { randomUUID } from 'node:crypto';
import type { JobDTO, JsonValue, Snapshot, ValidationBundle } from '@ce/contracts';
import type { WorkLimits } from '@ce/engine';
import type { JobAcceptance } from '../jobs/job-manager.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { ApiError } from '../errors.js';
export const validationKey = (workspaceId: string, runId: string) => 'validation:' + workspaceId + ':' + runId;
export function prepareValidation(snapshot: Snapshot, workspaceId: string, limits?: Partial<WorkLimits>): JobAcceptance {
  const id = randomUUID(), startedAt = new Date().toISOString(), key = validationKey(workspaceId, id), catalog = snapshot.content.catalog;
  const initial: ValidationBundle = { run: { id, versionId: snapshot.versionId, profileId: snapshot.content.profileId, status: 'running', startedAt,
    summary: { complete: false, rows: catalog.records.length, variants: catalog.variants.length, applicableVariants: catalog.coverage.applicableVariants, duplicateRows: catalog.coverage.duplicateRows,
      instances: 0, byStatus: { pass: 0, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 } }, resultIds: [], diagnostics: [] }, results: [] };
  return { input: { runId: id, startedAt, ...(limits ? { limits: limits as unknown as JsonValue } : {}) }, resultRef: { type: 'validation', id },
    initialRecords: [{ key, value: initial as unknown as JsonValue }],
    onTerminal: (job: JobDTO) => [{ key, value: { ...initial, run: { ...initial.run, status: 'incomplete', endedAt: job.endedAt ?? new Date().toISOString(),
      diagnostics: job.diagnostics.length ? job.diagnostics : [{ code: 'CANCELLED', message: 'La ejecución fue cancelada antes de completar sus resultados.' }] } } as unknown as JsonValue }] };
}
export function getValidation(store: WorkspaceStore, workspaceId: string, runId: string): ValidationBundle {
  store.get(workspaceId); const bundle = store.getRecord<ValidationBundle>(validationKey(workspaceId, runId)); if (!bundle) throw new ApiError('RESOURCE_NOT_FOUND'); return bundle;
}
