import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UUID_PATTERN, type JsonValue, type ValidationBundle } from '@ce/contracts';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { findCompatibleValidation, getValidation, prepareValidation, validationKey } from '../../apps/api/src/validation/validation-service.js';
import { replaceDirections } from '../../apps/api/src/recalculation/directions-service.js';
import { content } from '../helpers/foundation.js';
import { selectionSnapshot } from '../helpers/iteration004-fixtures.js';
import { reviewHarness } from '../helpers/direction-review-harness.js';
import { selectionHarness } from '../helpers/proposal-selection-harness.js';

describe('validation basis is independent of configuration versions', () => {
  it('allocates immutable UUID bases for imports, including a repeated identical import', () => {
    const store = new WorkspaceStore(), workspace = store.create('Basis SYNTHETIC');
    const first = store.publish(workspace.id, undefined, content());
    expect(first.validationBasisId).toMatch(UUID_PATTERN);
    expect(store.get(workspace.id).validationBasisId).toBe(first.validationBasisId);
    const second = store.publish(workspace.id, first.versionId, first.content);
    expect(second.validationBasisId).toMatch(UUID_PATTERN);
    expect(second.validationBasisId).not.toBe(first.validationBasisId);
    expect(store.snapshot(workspace.id, first.versionId).validationBasisId).toBe(first.validationBasisId);
  });

  it('retains the basis only for an explicit configuration publication and rejects changed inputs', () => {
    const store = new WorkspaceStore(), workspace = store.create('Basis SYNTHETIC');
    const first = store.publish(workspace.id, undefined, content());
    const configured = store.publish(workspace.id, first.versionId, { ...first.content, configVersion: 'new' }, [], 'configuration');
    expect(configured.validationBasisId).toMatch(UUID_PATTERN);
    expect(configured.validationBasisId).toBe(first.validationBasisId);
    expect(configured.content.facts).toBe(first.content.facts);
    expect(() => store.publish(workspace.id, configured.versionId, { ...configured.content, reportVersion: 'changed' }, [], 'configuration')).toThrow('INTERNAL_ERROR');
    const changedFacts = configured.content.facts.map(fact => ({ ...fact, originalText: '77', normalizedValue: { numerator: '77', denominator: '1' } }));
    expect(() => store.publish(workspace.id, configured.versionId, { ...configured.content, facts: changedFacts }, [], 'configuration')).toThrow('INTERNAL_ERROR');
    expect(store.current(workspace.id)).toBe(configured);
  });

  it('propagates the basis to initial/completed runs, workspace and serialized history/results', async () => {
    const h = await reviewHarness({ content: selectionSnapshot(2).content });
    const bundle = getValidation(h.store, h.workspace.id, h.input.runId);
    expect(bundle.run.validationBasisId).toMatch(UUID_PATTERN);
    expect(bundle.run.validationBasisId).toBe(h.snapshot.validationBasisId);
    const accepted = prepareValidation(h.snapshot, h.workspace.id);
    const initial = accepted.initialRecords![0]!.value as unknown as ValidationBundle;
    expect(initial.run.validationBasisId).toBe(h.snapshot.validationBasisId);
    const results = await h.app.inject({ url: h.base + '/runs/' + bundle.run.id + '/results', headers: h.headers });
    expect(results.statusCode).toBe(200);
    expect(results.json().run.validationBasisId).toBe(h.snapshot.validationBasisId);
    const history = await h.app.inject({ url: h.base + '/runs', headers: h.headers });
    expect(history.json().items[0].validationBasisId).toBe(h.snapshot.validationBasisId);
    const workspace = await h.app.inject({ url: h.base, headers: h.headers });
    expect(workspace.json().validationBasisId).toBe(h.snapshot.validationBasisId);
  });

  it('can configure twice using the complete validation of the same inputs without another validation', async () => {
    const h = await reviewHarness({ content: selectionSnapshot(2).content });
    const run = getValidation(h.store, h.workspace.id, h.input.runId);
    const choices = run.results.map(row => ({ instanceId: row.instanceId!, targetSide: 'left' as const }));
    const first = replaceDirections(h.store, h.workspace.id, choices);
    const second = replaceDirections(h.store, h.workspace.id, choices.slice(0, 1));
    expect(first.validationBasisId).toMatch(UUID_PATTERN);
    expect(second.validationBasisId).toBe(h.snapshot.validationBasisId);
    expect(h.store.listRecords('validation:' + h.workspace.id + ':')).toHaveLength(1);
    expect(second.content.facts).toBe(h.snapshot.content.facts);
  });

  it.each(['foreign-basis', 'incomplete'] as const)('does not reuse a %s run, even with the current version ID', async reason => {
    const h = await reviewHarness({ content: selectionSnapshot(2).content });
    const bundle = getValidation(h.store, h.workspace.id, h.input.runId);
    const replacement = { ...bundle, run: { ...bundle.run,
      ...(reason === 'foreign-basis' ? { validationBasisId: randomUUID() } : { status: 'incomplete', summary: { ...bundle.run.summary, complete: false } }),
    } };
    h.store.putRecords([{ key: validationKey(h.workspace.id, bundle.run.id), value: replacement as unknown as JsonValue }]);
    expect(() => replaceDirections(h.store, h.workspace.id, [])).toThrow('INVALID_DIRECTION');
    expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
  });

  it('chooses a complete compatible run rather than a later unrelated or incomplete historical result', async () => {
    const h = await reviewHarness({ content: selectionSnapshot(2).content });
    const original = getValidation(h.store, h.workspace.id, h.input.runId);
    const configured = replaceDirections(h.store, h.workspace.id, []);
    const later = ['unrelated', 'incomplete'].map(kind => ({ ...original, run: { ...original.run, id: randomUUID(), versionId: configured.versionId,
      startedAt: '2026-11-08T00:00:00.000Z', ...(kind === 'unrelated' ? { validationBasisId: randomUUID() } : { status: 'incomplete' as const, summary: { ...original.run.summary, complete: false } }),
    } }));
    h.store.putRecords(later.map(bundle => ({ key: validationKey(h.workspace.id, bundle.run.id), value: bundle as unknown as JsonValue })));
    expect(findCompatibleValidation(h.store, h.workspace.id, configured)?.run.id).toBe(original.run.id);
    const imported = h.store.publish(h.workspace.id, configured.versionId, configured.content);
    expect(findCompatibleValidation(h.store, h.workspace.id, imported)).toBeUndefined();
  });

  it('keeps legacy runs usable only for their exact version rather than inventing a basis', async () => {
    const h = await reviewHarness({ content: selectionSnapshot(2).content });
    const bundle = getValidation(h.store, h.workspace.id, h.input.runId);
    const { validationBasisId: _basis, ...legacyRun } = bundle.run;
    h.store.putRecords([{ key: validationKey(h.workspace.id, bundle.run.id), value: { ...bundle, run: legacyRun } as unknown as JsonValue }]);
    const configured = replaceDirections(h.store, h.workspace.id, []);
    expect(configured.versionId).not.toBe(h.snapshot.versionId);
    expect(() => replaceDirections(h.store, h.workspace.id, [])).toThrow('INVALID_DIRECTION');
  });

  it('retains the basis across review commit and accepts its source run for another configuration review', async () => {
    const h = await reviewHarness({ content: selectionSnapshot(2).content });
    const review = await h.ready();
    const response = await h.commit(review.id, review.revision);
    expect(response.statusCode, response.body).toBe(202);
    const job = await h.finish(response.json().jobId);
    expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
    const current = h.store.current(h.workspace.id)!;
    expect(current.validationBasisId).toMatch(UUID_PATTERN);
    expect(current.validationBasisId).toBe(h.snapshot.validationBasisId);
    const again = await h.prepare(randomUUID(), h.etag(), { runId: h.input.runId, baseVersionId: current.versionId });
    expect(again.statusCode, again.body).toBe(202);
    expect((await h.finish(again.json().jobId)).status).toBe('succeeded');
  });

  it('reserves a new application basis and publishes that same identity with its revalidation', async () => {
    const h = await selectionHarness(selectionSnapshot(2));
    const response = await h.applySelection(await h.applicationBody());
    expect(response.statusCode, response.body).toBe(202);
    const job = await h.finish(response.json().jobId);
    expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
    const current = h.store.current(h.workspace.id)!;
    expect(current.validationBasisId).toMatch(UUID_PATTERN);
    expect(current.validationBasisId).not.toBe(h.configuredSnapshot.validationBasisId);
    const detail = await h.app.inject({ url: h.base + '/applications/' + job.resultRef!.id, headers: h.headers });
    const receipt = detail.json().receipt;
    expect(getValidation(h.store, h.workspace.id, receipt.validationRunId).run.validationBasisId).toBe(current.validationBasisId);
    expect(getValidation(h.store, h.workspace.id, receipt.beforeValidationRunId).run.validationBasisId).toBe(h.configuredSnapshot.validationBasisId);
  });

  it('still rejects exporting a run as another configuration version even when the basis is compatible', async () => {
    const h = await reviewHarness({ content: selectionSnapshot(2).content });
    const current = replaceDirections(h.store, h.workspace.id, []);
    const response = await h.app.inject({ method: 'POST', url: h.base + '/exports', headers: { ...h.headers,
      'if-match': h.etag(), 'idempotency-key': randomUUID() }, payload: { kind: 'results', versionId: current.versionId, runId: h.input.runId } });
    expect(response.statusCode).toBe(412);
    expect(response.json().error.code).toBe('STALE_VERSION');
    expect(h.store.get(h.workspace.id).activeJobId).toBeUndefined();
  });
});
