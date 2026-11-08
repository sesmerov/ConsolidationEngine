import { inject, Injectable, InjectionToken } from '@angular/core';
import type { DownloadIntent } from '@ce/contracts';

/** The hosted connection supplies frontend/API/profile identity; no bearer belongs in this key. */
export const OPERATION_ATTEMPT_NAMESPACE = new InjectionToken<string>('CE operation attempt namespace', {
  providedIn: 'root', factory: () => `${globalThis.location?.origin ?? 'local'}|local`,
});
interface AttemptIdentity { readonly key: string; readonly etag: string; readonly operationId?: string; readonly jobId?: string }
export interface ExportOperationAttempt extends AttemptIdentity { readonly operation: 'export'; readonly intent: DownloadIntent }
export interface RecalculationOperationAttempt extends AttemptIdentity {
  readonly operation: 'recalculation'; readonly workspaceId: string; readonly baseVersionId: string;
  readonly validationBasisId: string; readonly runId: string; readonly reviewId: string; readonly expectedRevision: number;
}
export type OperationAttempt = ExportOperationAttempt | RecalculationOperationAttempt;
type Kind = OperationAttempt['operation'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
const ids = (value: Record<string, unknown>, fields: readonly string[]) => fields.every(k => typeof value[k] === 'string' && uuid.test(value[k]));
function valid(value: unknown): value is OperationAttempt {
  if (!object(value) || !ids(value, ['key']) || typeof value['etag'] !== 'string' || value['etag'].length < 1 || value['etag'].length > 1024) return false;
  if (['operationId','jobId'].some(k => Object.hasOwn(value,k) && !ids(value,[k]))) return false;
  const base = ['operation','key','etag']; const optional = ['operationId','jobId'];
  if (value['operation'] === 'recalculation') {
    const fields = ['workspaceId','baseVersionId','validationBasisId','runId','reviewId'];
    return keys(value,[...base,...fields,'expectedRevision'],optional) && ids(value,fields) && Number.isSafeInteger(value['expectedRevision']) && (value['expectedRevision'] as number) >= 1;
  }
  if (value['operation'] !== 'export' || !keys(value,[...base,'intent'],optional) || !object(value['intent'])) return false;
  const intent = value['intent'], fields = ['workspaceId','versionId',...(intent['kind'] === 'results' ? ['runId'] : [])];
  return ['report','results'].includes(String(intent['kind'])) && keys(intent,[...fields,'kind']) && ids(intent,fields);
}

@Injectable({ providedIn: 'root' })
export class OperationAttemptStore {
  private readonly prefix = 'ce.operation-attempt.v1:' + encodeURIComponent(inject(OPERATION_ATTEMPT_NAMESPACE)) + ':';
  get(kind: 'export', workspaceId: string): ExportOperationAttempt | null;
  get(kind: 'recalculation', workspaceId: string): RecalculationOperationAttempt | null;
  get(kind: Kind, workspaceId: string): OperationAttempt | null {
    const key = this.storageKey(kind,workspaceId), raw = sessionStorage.getItem(key); if (!raw) return null;
    try { const value: unknown = JSON.parse(raw);
      if (valid(value) && value.operation === kind && this.workspace(value) === workspaceId) return value;
    } catch { /* Invalid records never become a command. */ }
    sessionStorage.removeItem(key); return null;
  }
  save(attempt: OperationAttempt): void {
    if (!valid(attempt)) throw new Error('No se puede conservar un intento de operación inválido.');
    // Persist before sending. Storage failure must not silently turn a recoverable action into an uncertain new one.
    sessionStorage.setItem(this.storageKey(attempt.operation,this.workspace(attempt)),JSON.stringify(attempt));
  }
  clear(kind: Kind, workspaceId: string): void { sessionStorage.removeItem(this.storageKey(kind,workspaceId)); }
  clearAll(): void {
    for (let index = sessionStorage.length - 1; index >= 0; index--) { const key = sessionStorage.key(index); if (key?.startsWith(this.prefix)) sessionStorage.removeItem(key); }
  }
  private storageKey(kind: Kind, workspaceId: string): string { return this.prefix + kind + ':' + workspaceId; }
  private workspace(attempt: OperationAttempt): string { return attempt.operation === 'export' ? attempt.intent.workspaceId : attempt.workspaceId; }
}
