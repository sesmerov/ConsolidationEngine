import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { content, controlledFactory, nextTurn } from '../helpers/foundation.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const controlled = controlledFactory(), app = await createApp({ workerFactory: controlled.factory }); apps.push(app);
  const workspace = app.ce.store.create('Local adapters'); await app.ce.files.createWorkspace(workspace.id);
  return { app, controlled, owner: { sessionId: app.ce.store.sessionId, workspaceId: workspace.id } };
}

describe('local adapters behind asynchronous infrastructure ports', () => {
  it('separates metadata from explicit worker hydration and checks owner on every query', async () => {
    const h = await setup(), snapshot = h.app.ce.store.publish(h.owner.workspaceId, undefined, content());
    const repository = h.app.ce.adapters.repository;
    const metadata = await repository.workspace(h.owner);
    expect(metadata).toMatchObject({ id: h.owner.workspaceId, currentVersionId: snapshot.versionId, validationBasisId: snapshot.validationBasisId });
    expect(metadata).not.toHaveProperty('contexts'); expect(metadata).not.toHaveProperty('facts');
    expect(await repository.version(h.owner, snapshot.versionId)).not.toHaveProperty('content');
    expect(await repository.loadSnapshot(h.owner, snapshot.versionId)).toEqual(snapshot);
    await expect(repository.workspace({ ...h.owner, sessionId: randomUUID() })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(repository.loadSnapshot({ ...h.owner, workspaceId: randomUUID() }, snapshot.versionId)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('stores bounded private objects without exposing file paths and verifies reads', async () => {
    const h = await setup(), objects = h.app.ce.adapters.objects;
    const reference = await objects.put(h.owner, Buffer.from('synthetic object'));
    expect(Object.keys(reference).sort()).toEqual(['byteLength', 'objectId', 'sha256']);
    expect(Buffer.from(await objects.get(h.owner, reference)).toString()).toBe('synthetic object');
    await expect(objects.get({ ...h.owner, sessionId: randomUUID() }, reference)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(objects.get(h.owner, { ...reference, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(objects.put(h.owner, Buffer.alloc(3 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'UPLOAD_LIMIT' });
    await objects.remove(h.owner, reference.objectId);
    await expect(objects.get(h.owner, reference)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('dispatches only accepted references and duplicate delivery does not create another worker', async () => {
    const h = await setup();
    const job = h.app.ce.jobs.start({ workspaceId: h.owner.workspaceId, kind: 'validate', input: {} });
    const reference = { ...h.owner, jobId: job.jobId };
    await h.app.ce.adapters.dispatcher.dispatch(reference); await nextTurn();
    expect(h.controlled.workers).toHaveLength(1);
    await expect(h.app.ce.adapters.dispatcher.dispatch({ ...reference, sessionId: randomUUID() })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(h.app.ce.adapters.dispatcher.dispatch({ ...reference, jobId: randomUUID() })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    h.controlled.workers[0]!.complete({ records: [{ key: 'probe:port', value: true }] });
    await h.app.ce.adapters.dispatcher.dispatch(reference);
    expect(h.controlled.workers).toHaveLength(1);
    expect((await h.app.ce.adapters.repository.job(h.owner, job.jobId)).status).toBe('succeeded');
  });
});
