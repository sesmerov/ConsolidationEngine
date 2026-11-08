import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, operationReceiptSchema, uuidSchema } from '@ce/contracts';

export function registerOperations(app: FastifyInstance): void {
  app.get<{ Params: { operationId: string } }>('/api/v1/operations/:operationId', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['operationId'], properties: { operationId: uuidSchema } }, querystring: emptyQuerySchema, response: { 200: operationReceiptSchema } },
  }, async request => app.ce.idempotency.receiptByOperation(request.params.operationId));
  app.get<{ Params: { key: string } }>('/api/v1/operation-receipts/:key', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: uuidSchema } }, querystring: emptyQuerySchema, response: { 200: operationReceiptSchema } },
  }, async request => app.ce.idempotency.receiptByKey(request.params.key));
}
