import type { FastifyInstance } from 'fastify';
import { uuidSchema } from '@ce/contracts';
import type { WorkLimits } from '@ce/engine';
import { ApiError } from '../errors.js';
import { prepareValidation } from '../validation/validation-service.js';
import { registerJobRoute } from './jobs.js';
export function registerValidations(app: FastifyInstance, limits?: Partial<WorkLimits>): void {
  registerJobRoute(app, { path: '/workspaces/:workspaceId/validations', kind: 'validate', bodySchema: {
    type: 'object', additionalProperties: false, required: ['baseVersionId'], properties: { baseVersionId: uuidSchema },
  }, prepare: (request) => { const body = request.body as { baseVersionId: string }; return { input: body, baseVersionId: body.baseVersionId }; },
  accept: ({ workspaceId, baseVersionId }) => { if (!baseVersionId) throw new ApiError('INVALID_REQUEST'); return prepareValidation(app.ce.store.snapshot(workspaceId, baseVersionId), workspaceId, limits); } });
}
