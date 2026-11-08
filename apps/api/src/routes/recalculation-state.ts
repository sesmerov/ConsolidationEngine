import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, recalculationStateSchema, workspaceParamsSchema } from '@ce/contracts';
import { recalculationState } from '../recalculation/recalculation-state-service.js';
export function registerRecalculationState(app: FastifyInstance): void {
  app.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/recalculation-state', {
    schema: { params: workspaceParamsSchema, querystring: emptyQuerySchema, response: { 200: recalculationStateSchema } },
  }, request => recalculationState(app.ce.store, app.ce.directionReviews, request.params.workspaceId));
}
