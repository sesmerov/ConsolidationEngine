import type { FastifyInstance } from 'fastify';
import { createWorkspaceSchema, emptyQuerySchema, workspaceParamsSchema, compactWorkspaceQuerySchema } from '@ce/contracts';
import { requireCurrentVersion } from '../plugins/version-guard.js';
export function registerWorkspaces(app: FastifyInstance): void {
  app.post<{ Body: { name: string } }>('/api/v1/workspaces', { schema: { body: createWorkspaceSchema, querystring: emptyQuerySchema } }, async (request, reply) => {
    const workspace = app.ce.store.create(request.body.name.trim());
    try { await app.ce.files.createWorkspace(workspace.id); } catch (error) { app.ce.store.close(workspace.id); throw error; }
    return reply.code(201).header('ETag', '"empty"').send(workspace);
  });
  app.get<{ Params: { workspaceId: string }; Querystring:{compact?:string} }>('/api/v1/workspaces/:workspaceId', { schema: { params: workspaceParamsSchema, querystring: compactWorkspaceQuerySchema } }, async (request, reply) => {
    const id = request.params.workspaceId,workspace=app.ce.store.get(id);const {contexts,...metadata}=workspace;
    return reply.header('ETag', app.ce.store.etag(id)).send(request.query.compact==='true'?{...metadata,contextCount:contexts.length}:workspace);
  });
  app.delete<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId', { schema: { params: workspaceParamsSchema, querystring: emptyQuerySchema } }, async (request, reply) => {
    const id = request.params.workspaceId; requireCurrentVersion(request, app.ce.store, id);
    app.ce.store.beginClose(id); await app.ce.uploads.cancel(id); await app.ce.preparations.settle(id); await app.ce.jobs.cancelActive(id);
    app.ce.directionReviews.close(); await app.ce.inspections.close(id); await app.ce.files.removeWorkspace(id); app.ce.store.close(id); return reply.code(204).send();
  });
}
