import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DirectionDecisionState, RuleVariant, Snapshot } from '@ce/contracts';
import * as engine from '../src/index.js';
import { stableId } from '../src/resolver/instances.js';
import { context, coordinate, fact, ref } from './helpers/report-fixture.js';

const first = context();
const a = ref(coordinate({ row: '0010' }));
const b = ref(coordinate({ row: '0020' }));
const c = ref(coordinate({ row: '0030' }));
type Definition = [string, string, string?];
function fixture(definitions: Definition[], contexts = [first]) {
  const cells = contexts.flatMap(ctx => ['0010', '0020', '0030'].map(row => coordinate({ row, context: ctx })));
  const variants: RuleVariant[] = definitions.map(([code, expression, precondition], index) => ({
    code, expression, ...(precondition ? { precondition } : {}), variantId: stableId([code, expression, precondition]),
    framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false, tables: ['T'], active: true,
    referenceWindow: {}, severity: 'error', severityOriginal: 'error', sourceRecords: [code], sourceLocators: [{ row: index + 1 }],
  }));
  const snapshot: Snapshot = {
    versionId: randomUUID(), contentHash: 'c'.repeat(64), createdAt: '2026-11-06T00:00:00Z',
    content: {
      catalogVersion: 'c', reportVersion: 'r', configVersion: 'x', profileId: 'ce-dpmxl-0.9-closed-v2',
      contexts, coordinates: cells, facts: cells.map(cell => fact(cell, '5')), sources: [], directions: [],
      directionDecisionState: { schemaVersion: 1, mode: 'new' },
      catalog: {
        variants, records: variants.map(v => ({ id: v.code, code: v.code, variantId: v.variantId, sourceLocator: v.sourceLocators[0]!, originalFields: {}, diagnostics: [] })),
        analyses: [], coverage: { rows: variants.length, variants: variants.length, applicableVariants: variants.length, supportedVariants: variants.length, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 }
      },
    },
  };
  const run = engine.runValidation(snapshot, { runId: randomUUID(), startedAt: snapshot.createdAt });
  const options = () => ({ budget: new engine.WorkBudget(), reviewId: 'f4d7d553-4787-4964-a56c-361ab1eb7ea1' });
  function prepare(base = snapshot) { return engine.prepareDirectionProjection(base, run.results, options()); }
  return { snapshot, run, prepare, options };
}

describe('global direction review', () => {
  it('uses declared direct sides and distinguishes validation-only, structural exclusion, coverage and undetermined input', () => {
    const f = fixture([['left', a + '=' + b + '+1'], ['right', '2=' + c], ['both', a + '=' + b], ['none', a + '+1=2'],
    ['inequality', a + '<2'], ['conditional', a + '=if true then 1 else 2 endif'], ['text-guard', a + '=1', '"Banco"="Banco"'],
    ['inactive-date', a + '=1', 'if true then true else #2026-01-01#<#2026-02-01# endif']]);
    const seed = f.run.results[0]!;
    const p = engine.prepareDirectionProjection(f.snapshot, [...f.run.results,
    { id: 'coverage-row', code: 'coverage', variantIds: [], coverageOnly: true },
    { ...seed, id: 'unknown-row', code: 'unknown', instanceId: 'x', variantIds: ['missing'] },
    ], f.options());
    const rows = engine.readDirectionRows(p, { offset: 0, limit: 50 }).items;
    const lookup = (code: string) => rows.find(row => row.code === code)!;
    expect(lookup('left')).toMatchObject({ classification: 'singleLeft', state: 'included', origin: 'automatic' });
    expect(lookup('right')).toMatchObject({ classification: 'singleRight', state: 'included', selectedSide: 'right' });
    expect(lookup('both')).toMatchObject({ classification: 'both', state: 'pending' });
    for (const code of ['none', 'inequality', 'conditional', 'text-guard', 'inactive-date', 'coverage']) expect(lookup(code).state).toBe('excluded');
    expect(lookup('unknown').state).toBe('undetermined');
    expect(p.counts).toEqual({ totalRows: 10, included: 2, omitted: 0, pending: 1, conflicted: 0, excluded: 6, undetermined: 1 });
    expect(JSON.stringify(rows)).not.toContain('factKey');
  });

  it('finds a competing producer across pages and keeps identical coordinates in distinct contexts independent', () => {
    const other = context({ contextId: 'second', entityId: 'OTHER' });
    const f = fixture([['AAA', a + '=1'], ...Array.from({ length: 51 }, (_, i): Definition => ['M' + i, a + '<' + (i + 2)]), ['ZZZ', '2=' + a]], [first, other]);
    const p = f.prepare();
    const rows = engine.readDirectionRows(p, { limit: 200, offset: 0 }).items;
    const clashes = rows.filter(row => row.code === 'AAA' || row.code === 'ZZZ');
    expect(p.conflictGroupCount).toBe(2); expect(p.counts.conflicted).toBe(4);
    expect(new Set(clashes.map(row => row.groupId)).size).toBe(2);
    const firstPage = engine.readDirectionRows(p, { offset: 0, limit: 50 }).items;
    expect(firstPage.some(row => row.code === 'AAA')).toBe(true); expect(firstPage.some(row => row.code === 'ZZZ')).toBe(false);
    const winner = clashes[0]!;
    const group = engine.readDirectionRows(p, { offset: 0, limit: 1, groupId: winner.groupId! });
    expect(group.total).toBe(2); expect(group.items[0]?.producerCount).toBe(2);
    const resolved = engine.editDirectionProjection(p, [{ op: 'resolveGroup', groupId: winner.groupId!, winnerInstanceId: winner.instanceId! }], f.options());
    expect(resolved.counts.included).toBe(1); expect(resolved.counts.omitted).toBe(1);
    expect(resolved.conflictGroupCount).toBe(1); expect(p.conflictGroupCount).toBe(2);
  });

  it('does not infer a writable side from an unresolved binding or a missing source coordinate', () => {
    const f = fixture([['missing-cell', a + '={tT,r9999,c0010}'], ['stale-binding', a + '=2']]);
    const seeds = f.run.results.map(row => row.code === 'stale-binding'
      ? { ...row, binding: { contextId: 'missing-context' } } : row);
    const p = engine.prepareDirectionProjection(f.snapshot, seeds, f.options());
    expect(p.counts).toMatchObject({ included: 0, excluded: 0, undetermined: 2 });
    const { items } = engine.readDirectionRows(p, { state: 'undetermined', offset: 0, limit: 10 });
    expect(items.every(row => row.options.length === 0 && row.reasons.length > 0)).toBe(true);
    expect(engine.compileDirectionConfiguration(f.snapshot, p).directions).toEqual([]);
  });

  it('roundtrips saved choices and omissions without activating older or partial configurations', () => {
    const f = fixture([['A', a + '=1'], ['B', b + '=2'], ['C', c + '=' + a]]);
    const p = f.prepare();
    const rows = engine.readDirectionRows(p, { offset: 0, limit: 50 }).items;
    const omitted = engine.editDirectionProjection(p, [{ op: 'set', instanceId: rows[1]!.instanceId!, choice: 'omit' }], f.options());
    const compiled = engine.compileDirectionConfiguration(f.snapshot, omitted, f.options());
    const saved = { ...f.snapshot, content: { ...f.snapshot.content, directions: compiled.directions, directionDecisionState: compiled.decisionState } };
    const restored = engine.readDirectionRows(f.prepare(saved), { offset: 0, limit: 50 }).items;
    expect(restored.map(row => row.state)).toEqual(['included', 'omitted', 'pending']); expect(restored[0]?.origin).toBe('saved');
    const { directionDecisionState: _previous, ...legacyContent } = f.snapshot.content;
    expect(f.prepare({ ...f.snapshot, content: legacyContent }).counts.included).toBe(0);
    const replace: DirectionDecisionState = engine.replacedDirectionDecisionState();
    expect(f.prepare({ ...f.snapshot, content: { ...legacyContent, directionDecisionState: replace } }).counts.omitted).toBe(3);
  });

  it('resolves a group spanning multiple decision blocks and recovers a previously omitted competitor', () => {
    const definitions = Array.from({length: 270}, (_, index): Definition => ['RULE_' + String(index).padStart(3, '0'), a + '=' + (index + 1)]);
    const review = fixture(definitions).prepare();
    const [first] = engine.readDirectionRows(review, {offset: 0, limit: 1}).items;
    const last = engine.readDirectionRows(review, {groupId: first!.groupId!, offset: 269, limit: 1}).items[0]!;
    const resolved = engine.editDirectionProjection(review, [{op: 'resolveGroup', groupId: first!.groupId!, winnerInstanceId: last.instanceId!}]);
    expect(resolved.counts).toMatchObject({omitted: 269, included: 1, conflicted: 0});
    expect(engine.readDirectionRows(resolved, {state: 'omitted', offset: 268, limit: 1}).items[0]?.code).toBe('RULE_268');
    const clash = engine.editDirectionProjection(resolved, [{op: 'set', instanceId: first!.instanceId!, choice: 'suggest'}]);
    expect(engine.readDirectionRows(clash, {state: 'conflicted', offset: 1, limit: 1})).toMatchObject({total: 2, items: [{code: 'RULE_269'}]});
    const cleared = engine.editDirectionProjection(clash, [{op: 'omitAll'}]);
    const restored = engine.editDirectionProjection(cleared, [{op: 'set', instanceId: last.instanceId!, choice: 'suggest'}]);
    expect(engine.readDirectionRows(restored, {state: 'included', offset: 0, limit: 1})).toMatchObject({total: 1, items: [{code: 'RULE_269'}]});
  });

  it('aborts interrupted preparation and atomically rejects conflicting or fabricated edits', () => {
    const f = fixture([['A', a + '=1'], ['B', b + '=' + a]]);
    expect(() => engine.prepareDirectionProjection(f.snapshot, f.run.results, { ...f.options(), budget: new engine.WorkBudget({ cancelled: () => true }) })).toThrow();
    expect(() => engine.prepareDirectionProjection(f.snapshot, f.run.results, { ...f.options(), budget: new engine.WorkBudget({ limits: { edges: 0 } }) })).toThrowError(engine.WorkLimitError);
    const p = f.prepare(), rows = engine.readDirectionRows(p, { offset: 0, limit: 50 }).items;
    expect(() => engine.editDirectionProjection(p, [{ op: 'set', instanceId: rows[0]!.instanceId!, choice: 'omit' }, { op: 'set', instanceId: 'missing', choice: 'left' }], f.options())).toThrow();
    expect(p.counts.included).toBe(1);
    const clash = engine.editDirectionProjection(p, [{ op: 'set', instanceId: rows[1]!.instanceId!, choice: 'right' }], f.options());
    expect(clash.counts.conflicted).toBe(2); expect(() => engine.compileDirectionConfiguration(f.snapshot, clash, f.options())).toThrow();
  });

  it('compacts omitted decisions, applies the deterministic ties and rejects tampered worker output', () => {
    const f = fixture([['A', a + '=1'], ['B', b + '=2'], ['C', c + '=1'], ['D', c + '=' + a]]);
    const p = f.prepare(), rows = engine.readDirectionRows(p, { offset: 0, limit: 10 }).items;
    const clear = engine.editDirectionProjection(p, [{ op: 'omitAll' }]);
    const empty = engine.compileDirectionConfiguration(f.snapshot, clear);
    expect(empty).toEqual({
      directions: [], decisionState: {
        schemaVersion: 1, mode: 'reviewed', source: 'review', originDefault: 'explicit',
        originExceptions: [], unselectedDefault: 'omitted', unselectedExceptions: []
      }
    });
    expect(engine.verifyDirectionCompilation(clear, empty)).toBe(true);
    const edited = engine.editDirectionProjection(p, [{ op: 'set', instanceId: rows[1]!.instanceId!, choice: 'left' },
    { op: 'set', instanceId: rows[2]!.instanceId!, choice: 'omit' }]);
    const valid = engine.compileDirectionConfiguration(f.snapshot, edited);
    expect(valid.decisionState).toMatchObject({
      originDefault: 'explicit', originExceptions: [{ instanceId: rows[0]!.instanceId, origin: 'automatic' }],
      unselectedDefault: 'pending', unselectedExceptions: [rows[2]!.instanceId]
    });
    expect(engine.verifyDirectionCompilation(edited, JSON.parse(JSON.stringify(valid)))).toBe(true);
    const one = valid.directions[0]!, two = valid.directions[1]!;
    for (const fake of [
      { ...valid, directions: [one, one] }, { ...valid, directions: [two, one] },
      { ...valid, directions: [{ ...one, targetKey: 'somewhere else' }, two] },
      { ...valid, directions: [{ ...one, binding: { ...one.binding, contextId: 'spurious' } }, two] },
      { ...valid, decisionState: { ...valid.decisionState, originExceptions: [] } },
      { ...valid, decisionState: { ...valid.decisionState, unselectedExceptions: [rows[3]!.instanceId] } },
    ]) expect(engine.verifyDirectionCompilation(edited, fake)).toBe(false);
  });
});
