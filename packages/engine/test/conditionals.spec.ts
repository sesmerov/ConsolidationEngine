import { describe, expect, it } from 'vitest';
import { LANGUAGE_PROFILE_V2, type Snapshot } from '@ce/contracts';
import { evaluate, parseRule, runValidation, WorkBudget, WorkLimitError } from '../src/index.js';
import { coordinate, fact, ref, report } from './helpers/report-fixture.js';
const profileId = LANGUAGE_PROFILE_V2;
const condition = coordinate({ row: '0010', dataType: 'boolean' }), left = coordinate({ row: '0020', unit: 'EUR' }), right = coordinate({ row: '0030', unit: 'EUR' });
const input = report([condition, left, right], [fact(condition, null), fact(left, '4'), fact(right, '7')]);
function evaluateV2(source: string, data = input, budget?: WorkBudget) {
  const parsed = parseRule(source, { profileId }); expect(parsed.ast, JSON.stringify(parsed.diagnostics)).toBeDefined();
  return evaluate(parsed.ast!, { report: data, binding: { contextId: 'demo' }, ...{ profileId }, ...(budget ? { budget } : {}) });
}
function run(source: string, precondition?: string) {
  const variant = { variantId: 'a'.repeat(64), code: 'CONDITIONAL', expression: source, ...(precondition ? { precondition } : {}), framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false, tables: ['T'], active: true, referenceWindow: {}, severityOriginal: 'error', severity: 'error' as const, sourceRecords: ['row'], sourceLocators: [{ sheet: 'Rules', row: 2 }] };
  const snapshot: Snapshot = { versionId: '00000000-0000-4000-8000-000000000301', contentHash: 'a'.repeat(64), createdAt: '2026-11-04T00:00:00Z', content: {
    profileId, catalogVersion: 'c', reportVersion: 'r', configVersion: 'none', ...input, directions: [], sources: [], catalog: { records: [{ id: 'row', code: variant.code, variantId: variant.variantId, originalFields: {}, sourceLocator: variant.sourceLocators[0]!, diagnostics: [] }], variants: [variant], analyses: [], coverage: { rows: 1, variants: 1, applicableVariants: 1, supportedVariants: 1, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } } };
  return runValidation(snapshot, { runId: 'run', startedAt: snapshot.createdAt, now: () => 0 }).results[0]!;
}
describe('v2 conditionals use static types and only effective runtime reads', () => {
  it.each([['if true then true else false endif', true], ['if false then true else false endif', false], ['if true then if false then false else true endif else false endif', true], ['if false then 1/0=0 else true endif', true], ['if true then true else 1/0=0 endif', true]] as const)('evaluates %s', (source, expected) => {
    const result = evaluateV2(source); expect(result.value).toEqual({ kind: 'boolean', value: expected }); expect(result.diagnostics).toEqual([]); expect(result.readKeys).toEqual([]);
  });
  it('records the condition and selected branch, but never inactive fact values', () => {
    const data = report(input.coordinates, [fact(condition, true), fact(left, '4'), fact(right, '7')]);
    const result = evaluateV2(`if ${ref(condition)} then ${ref(left)}=4 else ${ref(right)}=7 endif`, data);
    expect(result.value).toEqual({ kind: 'boolean', value: true }); expect(result.readKeys).toEqual([condition.factKey, left.factKey].sort());
  });
  it('returns typed derived absence for false without else, preserving the unused numeric branch unit', () => {
    expect(evaluateV2('if false then true endif').value).toMatchObject({ kind: 'null', dataType: 'boolean', origin: 'derived' });
    expect(evaluateV2(`nvl((if false then ${ref(left)} endif),${ref(right)})=7`).value).toEqual({ kind: 'boolean', value: true });
    expect(evaluateV2(`nvl((if false then 1 endif),${ref(right)})=7`).value).toEqual({ kind: 'boolean', value: true });
    expect(evaluateV2(`isnull(if false then ${ref(left)} endif)`).readKeys).toEqual([]);
    expect(evaluateV2(`isnull(if false then ${ref(left)} endif)`).value).toEqual({ kind: 'boolean', value: true });
  });
  it.each(['if 1 then true else false endif', 'if true then 1 else "x" endif', 'if true then true else #2025-01-01# endif'])('rejects static incompatibility even in the omitted branch: %s', source => {
    expect(parseRule(source, { profileId }).diagnostics).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
  });
  it('checks coordinate types in both branches without reading either value on structural failure', () => {
    const result = evaluateV2(`if true then ${ref(condition)} else ${ref(left)} endif`);
    expect(result.value).toBeUndefined(); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' })); expect(result.readKeys).toEqual([]);
    const missing = evaluateV2('if true then true else {tT,r9999,c0010}=0 endif');
    expect(missing.value).toBeUndefined(); expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_COORDINATE' })); expect(missing.readKeys).toEqual([]);
  });
  it.each([ref(condition), '{v_MISSING}'])('does not choose a branch for absent/unknown condition %s', source => {
    const result = evaluateV2(`if ${source} then ${ref(left)}=4 else ${ref(right)}=7 endif`);
    expect(result.value).toMatchObject({ kind: 'unknown', dataType: 'boolean' }); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONDITIONAL_NOT_EVALUABLE' }));
    expect(result.readKeys).toEqual(source === ref(condition) ? [condition.factKey] : []);
  });
  it.each([
    `nvl((if ${ref(condition)} then true else false endif),true)`,
    `isnull(if ${ref(condition)} then true else false endif)`,
    `(if ${ref(condition)} then true else false endif) and false`,
    `(if ${ref(condition)} then true else false endif) or true`,
    `with {default:null}: nvl((if ${ref(condition)} then true else false endif),true)`,
  ])('never approves or marks not-applicable after conditional unknown was evaluated: %s', source => {
    const result = run(source); expect(result.status).toBe('not_evaluable'); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONDITIONAL_NOT_EVALUABLE' }));
    const guarded = run('true', source); expect(guarded.status).toBe('not_evaluable');
  });
  it('does not emit a dynamic conditional diagnostic from a branch that is never executed', () => {
    const result = run(`if true then true else (if ${ref(condition)} then true else false endif) endif`);
    expect(result.status).toBe('pass'); expect(result.readKeys).toEqual([]); expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'CONDITIONAL_NOT_EVALUABLE' }));
  });
  it('requires a boolean rule or precondition root after resolving conditional branches', () => {
    expect(run(`if true then ${ref(left)} else ${ref(right)} endif`).status).not.toBe('pass');
    expect(run('true', `if true then ${ref(left)} else ${ref(right)} endif`).status).not.toBe('pass');
  });
  it('enforces nesting and operation budgets without converting them into ordinary rule failures', () => {
    const deep = 'if true then '.repeat(140) + 'true' + ' endif'.repeat(140);
    expect(parseRule(deep, { profileId }).diagnostics).toContainEqual(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    expect(() => evaluateV2(`if ${ref(condition)} then true else false endif`, input, new WorkBudget({ now: () => 0, limits: { reads: 0 } }))).toThrow(WorkLimitError);
  });
});
