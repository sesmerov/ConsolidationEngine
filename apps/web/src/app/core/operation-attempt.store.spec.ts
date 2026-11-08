import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OperationAttemptStore, OPERATION_ATTEMPT_NAMESPACE } from './operation-attempt.store';
import type { ExportOperationAttempt, RecalculationOperationAttempt } from './operation-attempt.store';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const recalculation: RecalculationOperationAttempt = { operation: 'recalculation', workspaceId: id(1), baseVersionId: id(2), validationBasisId: id(3), runId: id(4), reviewId: id(5), expectedRevision: 7, key: id(6), etag: '"version-2"' };
const download: ExportOperationAttempt = { operation: 'export', intent: { workspaceId: id(1), versionId: id(2), kind: 'results', runId: id(4) }, key: id(7), etag: '"version-2"' };
function create(namespace = 'test-005') { TestBed.configureTestingModule({ providers: [{ provide: OPERATION_ATTEMPT_NAMESPACE, useValue: namespace }] }); return TestBed.inject(OperationAttemptStore); }
describe('minimal operation attempts', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => { TestBed.resetTestingModule(); sessionStorage.clear(); });
  it('recovers the same immutable command identity after reload and keeps operation types separate', () => {
    const store = create(); store.save(recalculation); store.save(download);
    const read = store.get('recalculation', id(1))!; expect(read).toEqual(recalculation);
    (read as {etag: string}).etag = 'changed'; expect(store.get('recalculation', id(1))!.etag).toBe('"version-2"');
    TestBed.resetTestingModule(); const reloaded = create();
    expect(reloaded.get('recalculation', id(1))).toEqual(recalculation); expect(reloaded.get('export', id(1))).toEqual(download);
    reloaded.clear('recalculation', id(1)); expect(reloaded.get('export', id(1))).toEqual(download);
  });
  it('isolates connection namespaces and clears only the current namespace', () => {
    create('A').save(download); TestBed.resetTestingModule(); const other = create('B');
    expect(other.get('export', id(1))).toBeNull(); other.save(download); other.clearAll();
    TestBed.resetTestingModule(); expect(create('A').get('export', id(1))).toEqual(download);
  });
  it('rejects business bodies, unknown keys, wrong IDs and mismatched export intent fields', () => {
    const store = create();
    for (const value of [{...recalculation, rules:['private']}, {...recalculation, expectedRevision:-1}, {...recalculation,key:'invalid'}, {...download,intent:{...download.intent,kind:'report'}}, {...download,intent:{...download.intent,facts:[]}}]) {
      expect(() => store.save(value as RecalculationOperationAttempt)).toThrow();
    }
    expect(sessionStorage.length).toBe(0);
  });
  it('persists reserved operation IDs without treating them as a published result', () => {
    const store = create(); store.save({...recalculation, operationId:id(8),jobId:id(8)});
    expect(store.get('recalculation', id(1))).toEqual({...recalculation,operationId:id(8),jobId:id(8)});
    expect(JSON.stringify(store.get('recalculation',id(1)))).not.toContain('resultRef');
  });
});
