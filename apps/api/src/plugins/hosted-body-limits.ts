import { Transform, type TransformCallback } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { PUBLIC_JSON_MAX_BYTES, TRANSFER_PART_MAX_BYTES } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { requestFailureKind, type OperationalLogger } from '../hosted/operational-log.js';

class CountedBody extends Transform {
  receivedEncodedLength = 0;
  constructor(private readonly limit: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.receivedEncodedLength += chunk.byteLength;
    if (this.receivedEncodedLength > this.limit) callback(new ApiError('UPLOAD_LIMIT', { reason: 'TRANSPORT_BODY_LIMIT', maxBytes: this.limit }));
    else callback(null, chunk);
  }
}
/** Route onRequest guards authorize resource/reservation before this parser accumulates private bytes. */
export function installHostedBodyLimits(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: PUBLIC_JSON_MAX_BYTES }, app.getDefaultJsonParser('error', 'error'));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: TRANSFER_PART_MAX_BYTES }, (_request, payload, done) => done(null, payload));
  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.startsWith('/api/v1/')) return payload;
    const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (contentType === 'multipart/form-data') throw new ApiError('INVALID_REQUEST', { reason: 'USE_TRANSFER_PARTS' });
    const limit = contentType === 'application/octet-stream' ? TRANSFER_PART_MAX_BYTES : PUBLIC_JSON_MAX_BYTES;
    const counted = new CountedBody(limit);
    payload.once('error', error => counted.destroy(error));
    counted.once('error', () => { payload.unpipe(counted); payload.resume(); });
    return payload.pipe(counted);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/api/v1/')) return payload;
    reply.header('Cache-Control', 'private, no-store'); reply.header('X-Content-Type-Options', 'nosniff');
    const contentType = String(reply.getHeader('content-type') ?? '').toLowerCase();
    const binary = contentType.startsWith('application/octet-stream');
    const limit = binary ? TRANSFER_PART_MAX_BYTES : PUBLIC_JSON_MAX_BYTES;
    // Public JSON routes must serialize a finite value, not stream an unbounded response around the budget.
    const size = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : Buffer.isBuffer(payload) ? payload.byteLength : payload == null ? 0 : Infinity;
    if (size > limit) {
      if (payload && typeof payload === 'object' && 'destroy' in payload && typeof payload.destroy === 'function') payload.destroy();
      reply.code(413).type('application/json; charset=utf-8').removeHeader('Content-Length');
      return JSON.stringify({ error: { code: 'RESPONSE_LIMIT', message: 'El resultado requiere una respuesta paginada o fragmentada.', requestId: request.id,
        locator: null, details: { reason: 'TRANSPORT_RESPONSE_LIMIT', maxBytes: limit } } });
    }
    return payload;
  });
}
/** Never serialize SQL/provider error messages, statements, parameters, paths, tokens or request bodies. */
export function installHostedErrorHandler(app: FastifyInstance, log?: OperationalLogger): void {
  app.setErrorHandler((error, request, reply) => {
    const metadata = error && typeof error === 'object' ? error as { validation?: unknown; statusCode?: number } : {};
    const known = error instanceof ApiError ? error : new ApiError(metadata.validation || metadata.statusCode === 400 ? 'INVALID_REQUEST'
      : metadata.statusCode === 413 ? 'UPLOAD_LIMIT' : metadata.statusCode === 415 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR');
    const retryAfter = known.details['retryAfterSeconds'];
    log?.('request_failed', { requestId: request.id, code: known.code, statusCode: known.statusCode,
      ...(known.code === 'INTERNAL_ERROR' ? { failureKind: requestFailureKind(error) } : {}) });
    if (typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0) reply.header('Retry-After', String(retryAfter));
    reply.header('Cache-Control', 'private, no-store');
    if (known.code === 'UPLOAD_LIMIT' && !request.raw.complete) {
      reply.header('Connection', 'close'); reply.raw.once('finish', () => request.raw.destroy());
    }
    return reply.code(known.statusCode).send({ error: { code: known.code, message: known.publicMessage, requestId: request.id, locator: known.locator, details: known.details } });
  });
}
