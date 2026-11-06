import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkBudget, WorkLimitError } from '@ce/engine';
import type { FactReadDTO, ProposalDTO, RuleResultDTO, SnapshotContent } from '@ce/contracts';
import { registerResults } from '../../apps/api/src/routes/results.js';
import { registerPreviews } from '../../apps/api/src/routes/previews.js';
import { registerApplications } from '../../apps/api/src/routes/applications.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { COREP_MAPPING_SHA256, COREP_PROFILE_ID } from '../../apps/api/src/import/profiles/corep-ca1.js';
import { DEMO_TYPES_MAPPING_SHA256, DEMO_TYPES_PROFILE_ID } from '../../apps/api/src/import/profiles/demo-types.js';
import { rulePresentation } from '../../apps/api/src/presentation/rule-presentation.js';
import { content } from '../helpers/foundation.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const hash = 'a'.repeat(64), instance = 'b'.repeat(64), fileId = randomUUID();
const r = (value: string) => ({ numerator: value, denominator: '1' });
const coordinate = { factKey: 'cell', contextId: 'demo', tableCode: 'C_01.00', sheetCode: '', rowCode: '0010', columnCode: '0010', dataType: 'number' as const, unit: 'EUR', decimals: '2', axes: {}, sourceLocator: { fileId, sheet: 'CA1', row: 5, column: 'E' } };
const fact = (value: string): FactReadDTO => ({ factKey: 'cell', coordinate, presence: 'value', normalizedValue: r(value), originalText: value, sourceLocator: coordinate.sourceLocator });
const effective = (value: string) => ({ kind: 'number' as const, nominal: r(value), interval: { lo: r(value), hi: r(value) }, unit: 'EUR' });
const summary = { complete: true, rows: 0, variants: 0, applicableVariants: 0, instances: 0, duplicateRows: 0, byStatus: { pass: 0, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 } };

function setup(profileId = 'ce-dpmxl-0.9-closed-v1', extra: Partial<SnapshotContent> = {}) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } }); apps.push(app);
  const store = new WorkspaceStore(), workspace = store.create('Presentation tests'); app.decorate('ce', { store });
  registerResults(app); registerPreviews(app); registerApplications(app);
  const recordIds = [randomUUID(), randomUUID()];
  const catalog: SnapshotContent['catalog'] = { ...content().catalog,
    records: recordIds.map((id, index) => ({ id, code: 'RULE', variantId: hash, sourceLocator: { fileId, sheet: 'Rules', row: index ? 2 : 3 }, originalFields: { Description: index ? { value: 'Capital disponible <b>texto</b>', xmlType: 'inlineStr', lexeme: 'Capital disponible <b>texto</b>', column: 'I' } : 'Descripción alternativa' }, diagnostics: [] })),
    variants: [{ variantId: hash, code: 'RULE', expression: '1=1', framework: 'COREP', modules: ['COREP_OF_4.0'], tables: [], crossModule: false, active: true, referenceWindow: {}, severity: 'error', severityOriginal: 'Error', sourceRecords: recordIds, sourceLocators: [] }],
  };
  const snapshot = store.publish(workspace.id, undefined, { ...content(), profileId, facts: [], coordinates: [], catalog, ...extra });
  const base = `/api/v1/workspaces/${workspace.id}`;
  const result = (code: string, value = '1'): RuleResultDTO => ({ id: randomUUID(), runId: randomUUID(), versionId: snapshot.versionId, profileId, code, variantIds: [hash], sourceRecordIds: recordIds, coverageOnly: true, tables: [], status: 'pass', severity: 'error', severityOriginal: 'Error', expression: '1=1', values: { left: effective(value), right: effective(value), result: { kind: 'boolean', value: true } }, readKeys: ['cell'], factReads: [fact(value)], metadataReads: [], sources: [], diagnostics: [] });
  const saveRun = (rows: readonly RuleResultDTO[], versionId = snapshot.versionId) => {
    const id = randomUUID(), results = rows.map(row => ({ ...row, id: randomUUID(), runId: id, versionId }));
    const run = { id, versionId, profileId, status: 'completed', startedAt: new Date().toISOString(), summary: { ...summary, rows: rows.length }, resultIds: results.map(row => row.id), diagnostics: [] };
    store.putInternalRecord(`validation:${workspace.id}:${id}`, { run, results }); return { run, results };
  };
  const savePreview = (id = randomUUID(), withCalculation = true) => {
    const producerId = randomUUID(), proposalId = randomUUID();
    const make = (proposalId: string, dependency: boolean) => ({ id: proposalId, previewId: id, directionId: hash, instanceId: instance, variantIds: [hash], binding: {}, code: 'RULE', targetKey: 'cell', before: fact('1'), after: { normalizedValue: r('3'), originalText: '3.00', decimals: '2', unit: 'EUR' }, exactNominal: r('3'), derivedInterval: { lo: r('3'), hi: r('3') }, readKeys: ['cell'], predecessorIds: dependency ? [producerId] : [], metadataReads: [], sources: [], state: 'available', diagnostics: [],
      ...(withCalculation ? { calculation: { expression: '{tC_01.00,r0010,c0010}=3', sourceValue: { ...effective('3'), privatePath: 'private-sentinel' }, reads: [{ fact: { ...fact('2'), ast: 'private-sentinel' }, ...(dependency ? { fromProposalId: producerId } : {}) }], ast: 'private-sentinel' } } : {}), ast: 'private-sentinel' });
    const bundle = { preview: { id, baseVersionId: snapshot.versionId, profileId, policyId: 'half-even-v1', createdAt: new Date().toISOString(), state: 'ready', proposalIds: [producerId, proposalId], graphSummary: { nodes: 2, edges: 1, order: [hash, instance], conflicts: [], cycles: [], blocked: 0 }, diagnostics: [] }, proposals: [make(producerId, false), make(proposalId, true)] };
    store.putInternalRecord(`preview:${workspace.id}:${id}`, bundle); return { id, proposalId, producerId, bundle };
  };
  const saveComparison = (beforeRows: readonly RuleResultDTO[], afterRows: readonly RuleResultDTO[]) => {
    const afterSnapshot = store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, reportVersion: 'two' });
    const before = saveRun(beforeRows), after = saveRun(afterRows, afterSnapshot.versionId), id = randomUUID();
    const receipt = { id, previewId: randomUUID(), acceptedIds: [randomUUID()], closureHash: hash, baseVersionId: snapshot.versionId, newVersionId: afterSnapshot.versionId, beforeValidationRunId: before.run.id, validationRunId: after.run.id, appliedAt: new Date().toISOString() };
    store.putInternalRecord(`application:${workspace.id}:${id}`, { receipt, changes: [] }); return id;
  };
  return { app, store, workspace, snapshot, base, result, saveRun, savePreview, saveComparison };
}

describe('presentation and stored calculation details', () => {
  it('resolves typed field labels only from the trusted profile binding', () => {
    const binding = { profileId: DEMO_TYPES_PROFILE_ID, mappingSha256: DEMO_TYPES_MAPPING_SHA256, sourceFileId: fileId, contextIds: ['demo_types'], selectedSheets: ['Datos'], excludedSheets: [], contextOrigin: 'workbook' as const };
    const cell = { ...coordinate, contextId: 'demo_types', tableCode: 'DEMO_TYPES', dataType: 'text' as const, unit: '', decimals: '' };
    const present = rulePresentation({ ...content(), reportSourceBindings: [binding] });
    expect(present([], cell)).toEqual({ conceptLabel: 'Categoría' });
    expect(present([], { ...cell, sourceLocator: { fileId: randomUUID() } })).toBeUndefined();
    expect(present([], { ...cell, tableCode: 'OTHER' })).toBeUndefined();
    expect(rulePresentation({ ...content(), reportSourceBindings: [{ ...binding, mappingSha256: '0'.repeat(64) }] })([], cell)).toBeUndefined();
  });
  it('uses the server COREP mapping only for the exact bound profile, source and context', async () => {
    const binding = { profileId: COREP_PROFILE_ID, mappingSha256: COREP_MAPPING_SHA256, sourceFileId: fileId, contextIds: ['demo'], selectedSheets: ['CA1'], excludedSheets: [], contextOrigin: 'form' as const };
    const f = setup('ce-dpmxl-0.9-closed-v2', { reportSourceBindings: [binding] }), run = f.saveRun([f.result('RULE')]), preview = f.savePreview();
    const result = await f.app.inject({ url: `${f.base}/runs/${run.run.id}/results` }); expect(result.statusCode, result.body).toBe(200);
    expect(result.json().items[0].presentation).toEqual({ description: 'Capital disponible <b>texto</b>', conceptLabel: 'OWN FUNDS' });
    const proposal = await f.app.inject({ url: `${f.base}/previews/${preview.id}/proposals/${preview.proposalId}` }); expect(proposal.statusCode, proposal.body).toBe(200);
    expect(proposal.json().presentation.conceptLabel).toBe('OWN FUNDS');
    for (const altered of [{ ...binding, mappingSha256: 'f'.repeat(64) }, { ...binding, profileId: 'ce-report-1' as const }, { ...binding, sourceFileId: randomUUID() }, { ...binding, contextIds: ['other'] }]) {
      expect(rulePresentation({ ...f.snapshot.content, reportSourceBindings: [altered] })([hash], coordinate)?.conceptLabel).toBeUndefined();
    }
    expect(rulePresentation(f.snapshot.content)([hash], { ...coordinate, rowCode: '9999' })?.conceptLabel).toBeUndefined();
  });
  it.each(['ce-dpmxl-0.9-closed-v1', 'ce-dpmxl-0.9-closed-v2'])('adds trusted stable descriptions without changing %s policy', async profile => {
    const f = setup(profile), run = f.saveRun([f.result('RULE')]);
    const response = await f.app.inject({ url: `${f.base}/runs/${run.run.id}/results` }); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0].presentation).toEqual({ description: 'Capital disponible <b>texto</b>' });
    expect(response.json().items[0].recalculation.policy).toEqual({ profileId: profile, mode: 'standard', reasons: [] });
    const compact = await f.app.inject({ url: `${f.base}/runs/${run.run.id}/results?includeConfiguredDirections=false` });
    expect(compact.statusCode).toBe(200);
    expect(compact.json().items).toEqual(response.json().items);
    expect(compact.json()).not.toHaveProperty('configuredDirections');
    expect((await f.app.inject({ url: `${f.base}/runs/${run.run.id}/results?includeConfiguredDirections=no` })).statusCode).toBe(400);
  });
  it('omits unavailable labels rather than inventing business concepts', async () => {
    const f = setup(), run = f.saveRun([{ ...f.result('UNKNOWN'), variantIds: [], sourceRecordIds: [] }]);
    const response = await f.app.inject({ url: `${f.base}/runs/${run.run.id}/results` }); expect(response.statusCode).toBe(200);
    expect(response.json().items[0].presentation).toBeUndefined();
  });
  it('resolves an off-page proposal by ownership and returns only retained overlay evidence', async () => {
    const f = setup(), preview = f.savePreview();
    const first = await f.app.inject({ url: `${f.base}/previews/${preview.id}/proposals?limit=1` }); expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items.map((p: ProposalDTO) => p.id)).toEqual([preview.producerId]);
    expect(first.json().items[0].calculation).toBeUndefined(); expect(first.body).not.toContain('private-sentinel');
    const response = await f.app.inject({ url: `${f.base}/previews/${preview.id}/proposals/${preview.proposalId}` }); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().presentation.description).toBe('Capital disponible <b>texto</b>');
    expect(response.json().calculation.reads).toEqual([{ fact: fact('2'), fromProposalId: preview.producerId }]);
    expect(response.json().calculation.sourceValue).toEqual(effective('3')); expect(response.body).not.toContain('private-sentinel');
    const other = f.savePreview();
    for (const url of [`${f.base}/previews/${other.id}/proposals/${preview.proposalId}`, `${f.base}/previews/${preview.id}/proposals/${randomUUID()}`, `/api/v1/workspaces/${randomUUID()}/previews/${preview.id}/proposals/${preview.proposalId}`]) expect((await f.app.inject({ url })).statusCode).toBe(404);
  });
  it('keeps legacy proposals without invented calculation and binds cursors to preview state and filters', async () => {
    const f = setup(), preview = f.savePreview(undefined, false), url = `${f.base}/previews/${preview.id}/proposals`;
    const detail = await f.app.inject({ url: `${url}/${preview.proposalId}` }); expect(detail.statusCode).toBe(200); expect(detail.json().calculation).toBeUndefined();
    const first = (await f.app.inject({ url: `${url}?limit=1` })).json(), cursor = encodeURIComponent(first.nextCursor);
    expect((await f.app.inject({ url: `${url}?limit=1&code=RULE&cursor=${cursor}` })).statusCode).toBe(400);
    f.store.putInternalRecord(`preview:${f.workspace.id}:${preview.id}`, { ...preview.bundle, preview: { ...preview.bundle.preview, state: 'obsolete' } });
    expect((await f.app.inject({ url: `${url}?limit=1&cursor=${cursor}` })).statusCode).toBe(400);
  });
  it('accounts retained calculation bytes and refuses an oversized bundle without publishing partial state', () => {
    const f = setup(), preview = f.savePreview(undefined, false), key = `preview:${f.workspace.id}:${preview.id}`, before = f.store.bytes;
    const calculation = { expression: '1+1=2', reads: [{ fact: fact('2'), fromProposalId: preview.producerId }], sourceValue: effective('3') };
    const explained = { ...preview.bundle, proposals: preview.bundle.proposals.map(proposal => ({ ...proposal, calculation })) };
    f.store.putInternalRecord(key, explained); expect(f.store.bytes).toBeGreaterThan(before);
    expect(Object.isFrozen(f.store.getRecord<typeof explained>(key)!.proposals[0]!.calculation)).toBe(true);
    const limited = new WorkspaceStore({ maxBytes: before + 1_000 }), workspace = limited.create('Presentation tests');
    const snapshot = limited.publish(workspace.id, undefined, f.snapshot.content);
    limited.putInternalRecord(key, preview.bundle);
    const retained = limited.getRecord(key), size = limited.bytes;
    expect(() => limited.putInternalRecord(key, { ...explained, proposals: explained.proposals.map(proposal => ({ ...proposal, calculation: { ...calculation, expression: '1+'.repeat(25_000) + '1=2' } })) })).toThrowError(expect.objectContaining({ code: 'SESSION_LIMIT' }));
    expect(limited.getRecord(key)).toBe(retained); expect(limited.current(workspace.id)).toBe(snapshot); expect(limited.bytes).toBe(size);
  });
});

describe('semantic comparison filtering before pagination', () => {
  it('includes pass-to-pass value changes globally and ignores generated identity, provenance and cosmetics', async () => {
    const f = setup(), unchanged = Array.from({ length: 55 }, (_, index) => f.result(`A${index.toString().padStart(3, '0')}`));
    const before = [...unchanged, f.result('Z1'), f.result('Z2'), f.result('Z3'), f.result('Z4')];
    const after = [...unchanged.map(row => ({ ...row, sources: [{ row: 999 }], factReads: row.factReads.map(read => ({ ...read, originalText: '1.00', sourceLocator: { row: 999 }, derivation: { receiptId: randomUUID(), previewId: randomUUID(), proposalId: randomUUID(), baseVersionId: f.snapshot.versionId } })), presentation: { description: 'Nueva etiqueta' } })),
      f.result('Z1', '2'), { ...f.result('Z2'), diagnostics: [{ code: 'DIFFERENT', message: 'Otro diagnóstico' }] }, { ...f.result('Z3'), factReads: [fact('4')] }, { ...f.result('Z4'), preconditionResult: { kind: 'boolean' as const, value: false } }];
    const receiptId = f.saveComparison(before, after), url = `${f.base}/applications/${receiptId}/comparison`;
    const all = await f.app.inject({ url }); expect(all.statusCode, all.body).toBe(200); expect(all.json().total).toBe(59);
    const first = await f.app.inject({ url: `${url}?changedOnly=true&limit=1` }); expect(first.statusCode, first.body).toBe(200);
    expect(first.json().total).toBe(4); expect(first.json().items[0].before.code).toBe('Z1'); expect(first.json().items[0].before.status).toBe('pass'); expect(first.json().items[0].after.status).toBe('pass');
    const cursor = encodeURIComponent(first.json().nextCursor);
    const next = await f.app.inject({ url: `${url}?changedOnly=true&limit=1&cursor=${cursor}` }); expect(next.statusCode).toBe(200); expect(next.json().items[0].before.code).toBe('Z2');
    expect((await f.app.inject({ url: `${url}?changedOnly=false&limit=1&cursor=${cursor}` })).statusCode).toBe(400);
    expect((await f.app.inject({ url: `${url}?changedOnly=1` })).statusCode).toBe(400);
  });
  it('detects added, removed, status, metadata and typed-value changes without comparing timestamps', async () => {
    const f = setup('ce-dpmxl-0.9-closed-v2'), base = ['ADDED', 'REMOVED', 'STATUS', 'METADATA', 'TEXT', 'DATE', 'EMPTY'].map(code => f.result(code));
    const before = base.filter(row => row.code !== 'ADDED').map(row => row.code === 'TEXT' ? { ...row, values: { result: { kind: 'text' as const, value: '' } } } : row.code === 'DATE' ? { ...row, values: { result: { kind: 'date' as const, value: '2024-02-29' } } } : row);
    const after = base.filter(row => row.code !== 'REMOVED').map(row => row.code === 'STATUS' ? { ...row, status: 'fail' as const } : row.code === 'METADATA' ? { ...row, metadataReads: [{ contextId: 'demo', code: 'C_01.00', presence: 'declared' as const, value: true }] } : row.code === 'TEXT' ? { ...row, values: { result: { kind: 'text' as const, value: ' ' } } } : row.code === 'DATE' ? { ...row, values: { result: { kind: 'date' as const, value: '2024-03-01' } } } : row);
    const receiptId = f.saveComparison(before, after), response = await f.app.inject({ url: `${f.base}/applications/${receiptId}/comparison?changedOnly=true` });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().total).toBe(6);
    expect(response.json().items.map((row: { before?: RuleResultDTO; after?: RuleResultDTO }) => row.before?.code ?? row.after?.code)).not.toContain('EMPTY');
  });
  it('compares rational values exactly and ignores equivalent spelling and read ordering', async () => {
    const f = setup(), before = f.result('SAME'), value = { numerator: '2', denominator: '2' };
    const after = { ...before, values: { ...before.values, left: { kind: 'number' as const, nominal: value, interval: { lo: value, hi: value }, unit: 'EUR' } },
      factReads: [{ ...fact('1'), normalizedValue: value, originalText: '1.000' }] };
    const receiptId = f.saveComparison([before], [after]), response = await f.app.inject({ url: `${f.base}/applications/${receiptId}/comparison?changedOnly=true` });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().total).toBe(0);
  });
  it.each(['RESOURCE_LIMIT', 'CANCELLED', 'DEADLINE_EXCEEDED'] as const)('never returns a partial comparison when %s interrupts global filtering', async code => {
    const f = setup(), row = f.result('RULE'), receiptId = f.saveComparison([row], [f.result('RULE', '2')]), base = f.store.current(f.workspace.id), bytes = f.store.bytes;
    const check = vi.spyOn(WorkBudget.prototype, 'check').mockImplementation(() => { throw new WorkLimitError(code, 'Controlled query interruption'); });
    try {
      const response = await f.app.inject({ url: `${f.base}/applications/${receiptId}/comparison?changedOnly=true` });
      expect(response.statusCode, response.body).toBe(413); expect(response.json().items).toBeUndefined();
      expect(f.store.current(f.workspace.id)).toBe(base); expect(f.store.bytes).toBe(bytes);
    } finally { check.mockRestore(); }
  });
});
