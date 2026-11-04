import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultsStore } from '../validation/results.store';
import { SessionStore } from './session.store';
import { ApiClient } from './api-client';
import { CursorPage, spanishPaginator } from './cursor-page';

describe('bounded server pages', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('supports previous visited pages, resets on filter identity and rejects unvisited jumps', () => {
    const cursor = new CursorPage(); expect(cursor.begin('all')).toEqual({ index: 0 }); cursor.accept(0, 101, 'second');
    expect(cursor.begin('all', 1)).toEqual({ index: 1, cursor: 'second' }); cursor.accept(1, 101, 'third');
    expect(cursor.begin('all', 0)).toEqual({ index: 0 }); expect(cursor.begin('all', 2).cursor).toBe('third');
    expect(() => cursor.begin('all', 3)).toThrow(); expect(cursor.begin('filtered', 1)).toEqual({ index: 0 }); expect(() => cursor.begin('filtered', 1)).toThrow();
  });
  it('accepts the documented cursor and total limits without truncation, rejecting larger or non-ASCII input', () => {
    const cursor = new CursorPage(); cursor.begin('bounded'); cursor.accept(0, 1_000_000, 'x'.repeat(8192)); expect(cursor.begin('bounded', 1).cursor).toHaveLength(8192);
    expect(() => cursor.accept(0, 1_000_001, null)).toThrow('1 000 000'); expect(() => cursor.accept(0, 100, 'x'.repeat(8193))).toThrow(); expect(() => cursor.accept(0, 100, 'á')).toThrow(); expect(() => cursor.accept(0, 100, 'cursor\n')).toThrow();
    for (let index = 1; index < 19999; index++) cursor.accept(index, 1_000_000, 'c' + index);
    expect(cursor.begin('bounded', 19999).cursor).toBe('c19998'); cursor.accept(19999, 1_000_000, null, 50);
    expect(() => cursor.accept(20000, 1_000_000, null)).toThrow(); expect(() => cursor.accept(19999, 1_000_000, 'overflow')).toThrow();
  });
  it('rejects missing/extra cursors, partial pages and indices outside the reported total', () => {
    const cursor = new CursorPage(); cursor.begin('inconsistent');
    expect(() => cursor.accept(0, 51, null, 50)).toThrow(); expect(() => cursor.accept(0, 50, 'extra', 50)).toThrow();
    expect(() => cursor.accept(1, 50, null, 0)).toThrow(); expect(() => cursor.accept(0, 51, 'next', 49)).toThrow();
    cursor.accept(0, 0, null, 0); expect(() => cursor.accept(1, 0, null, 0)).toThrow();
  });
  it('names the available navigation in Spanish with a fixed fifty-row range', () => {
    const labels = spanishPaginator(); expect(labels.nextPageLabel).toBe('Siguiente'); expect(labels.previousPageLabel).toBe('Anterior'); expect(labels.getRangeLabel(1, 50, 51)).toBe('51–51 de 51');
  });
  it('replaces the current page instead of retaining all previously visited result payloads', async () => {
    const run = { id: 'run', versionId: 'v1', startedAt: '2026-11-04', summary: { byStatus: {} } };
    const first = Array.from({ length: 50 }, (_, n) => ({ id: String(n) }));
    const results = vi.fn().mockResolvedValueOnce({ items: first, total: 51, nextCursor: 'cursor-page-2', versionId: 'v1', run })
      .mockResolvedValueOnce({ items: [{ id: '50' }], total: 51, nextCursor: null, versionId: 'v1', run });
    TestBed.configureTestingModule({ providers: [ResultsStore, { provide: ApiClient, useValue: { results, runs: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }) } }] });
    const session = TestBed.inject(SessionStore); session.workspace.set({ id: 'w', name: 'SYNTHETIC', state: 'ready', currentVersionId: 'v1', versionIds: ['v1'], contexts: [], counts: { snapshots: 1, coordinates: 0, facts: 0, sources: 0 }, sessionBytes: 0 });
    const store = TestBed.inject(ResultsStore); TestBed.tick(); await Promise.resolve(); store.selectedRunId.set('run');
    await store.load(); await store.load(true);
    expect(store.page()?.items.map(row => row.id)).toEqual(['50']);
    expect(results.mock.calls[1]?.[2]).toMatchObject({ cursor: 'cursor-page-2' });
  });
});
