import type { FastifyInstance } from 'fastify';
import { recalculationOperationSchema } from '@ce/contracts';
import type { JsonValue, RecalculationOperationDTO, RecalculationOperationAcceptedDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { registerJobRoute } from './jobs.js';
export function registerRecalculationOperations(app: FastifyInstance): void {
  registerJobRoute(app, { path: '/workspaces/:workspaceId/recalculation-operations', kind: 'recalculation-operation', bodySchema: recalculationOperationSchema,
    prepare: request => { const body = request.body as RecalculationOperationDTO; return { input: body as unknown as JsonValue, baseVersionId: body.baseVersionId }; },
    accept: ({ workspaceId, input, jobId }) => app.ce.recalculationOperations.accept(workspaceId, input as unknown as RecalculationOperationDTO, jobId),
    respond: (_job, receipt): RecalculationOperationAcceptedDTO => {
      const reservation = receipt.reservation;
      if (reservation?.kind !== 'recalculation') throw new ApiError('INTERNAL_ERROR');
      return { operationId: receipt.operationId, jobId: receipt.jobId, inputVersionId: reservation.inputVersionId,
        effectiveVersionId: reservation.effectiveVersionId, reservedPreviewId: reservation.reservedPreviewId };
    },
  });
}
