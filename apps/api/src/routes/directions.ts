import type { FastifyInstance } from 'fastify';
import { directionsRequestSchema, emptyQuerySchema, workspaceParamsSchema } from '@ce/contracts';
import type { DirectionsRequestDTO, DirectionsResponseDTO } from '@ce/contracts';
import { requireCurrentVersion } from '../plugins/version-guard.js';
import { replaceDirections } from '../recalculation/directions-service.js';
export function registerDirections(app: FastifyInstance): void {
  app.put<{ Params: { workspaceId: string }; Body: DirectionsRequestDTO }>('/api/v1/workspaces/:workspaceId/directions', {
    schema: { params: workspaceParamsSchema, body: directionsRequestSchema, querystring: emptyQuerySchema },
  }, async (request, reply) => {
    const id = request.params.workspaceId; requireCurrentVersion(request, app.ce.store, id);
    const snapshot = replaceDirections(app.ce.store, id, request.body.directions);
    const response: DirectionsResponseDTO = { versionId: snapshot.versionId, configVersion: snapshot.content.configVersion, directions: snapshot.content.directions };
    return reply.header('ETag', app.ce.store.etag(id)).send(response);
  });
}
