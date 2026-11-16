import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createOperationalLogger, requestFailureKind } from '../../apps/api/src/hosted/operational-log.js';
import { installHostedErrorHandler } from '../../apps/api/src/plugins/hosted-body-limits.js';

it('emits only operational allowlisted fields, never bodies, credentials or provider exception messages', () => {
  const sink = vi.fn(), log = createOperationalLogger(sink), requestId = randomUUID();
  log('request_failed', { requestId, code: 'SESSION_EXPIRED', statusCode: 410, token: 'secret-token', creationNonce: 'secret-nonce',
    message: 'provider body contains a password', body: { facts: ['private'] }, url: 'https://private/object' } as never);
  expect(sink).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sink.mock.calls[0]![0])).toEqual({ event: 'request_failed', requestId, code: 'SESSION_EXPIRED', statusCode: 410 });
});
it('discards malformed identifiers and diagnostic text, and cannot fail a business transaction when a sink fails', () => {
  const sink = vi.fn(), log = createOperationalLogger(sink);
  log('job_terminal', { requestId: 'credential', jobId: 'private/path', code: 'untrusted error text', durationMs: -1, count: Infinity } as never);
  expect(JSON.parse(sink.mock.calls[0]![0])).toEqual({ event: 'job_terminal' });
  log('unknown-event-secret' as never, {}); expect(sink).toHaveBeenCalledTimes(1);
  expect(() => createOperationalLogger(() => { throw new Error('sink down'); })('cleanup_delayed', { count: 2 })).not.toThrow();
});
it('allows only fixed provider and request diagnostic categories', () => {
  const sink = vi.fn(), log = createOperationalLogger(sink);
  log('provider_failed', { providerOperation: 'blob-read', providerReason: 'missing-length' });
  expect(JSON.parse(sink.mock.calls[0]![0])).toEqual({ event: 'provider_failed', providerOperation: 'blob-read', providerReason: 'missing-length' });
  log('request_failed', { failureKind: 'database-constraint' });
  expect(JSON.parse(sink.mock.calls[1]![0])).toEqual({ event: 'request_failed', failureKind: 'database-constraint' });
  log('provider_failed', { providerOperation: 'secret-path', providerReason: 'secret-message', failureKind: 'secret-sql' } as never);
  expect(JSON.parse(sink.mock.calls[2]![0])).toEqual({ event: 'provider_failed' });
  for (const [error, expected] of [
    [{ code: '42501', message: 'private SQL' }, 'database-permission'], [{ code: '23505' }, 'database-constraint'],
    [{ code: '57014' }, 'database-timeout'], [{ code: '08006' }, 'database-error'],
    [{ code: 'FST_ERR_CTP_INVALID_JSON_BODY' }, 'body-parser'], [new TypeError('private'), 'type-error'],
    [new RangeError('private'), 'range-error'], [Object.assign(new Error('private'), { name: 'AbortError' }), 'timeout'],
    [new Error('private'), 'unknown'],
  ] as const) expect(requestFailureKind(error)).toBe(expected);
});
it('keeps request diagnostic categories in the server log and never in public errors', async () => {
  const sink = vi.fn(), app = Fastify({ genReqId: () => randomUUID() });
  installHostedErrorHandler(app, createOperationalLogger(sink));
  app.post('/failure', async () => { throw Object.assign(new Error('secret SQL and provider token'), { code: '23505', detail: 'private row' }); });
  try {
    const response = await app.inject({ method: 'POST', url: '/failure' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({ code: 'INTERNAL_ERROR', details: {}, locator: null });
    expect(response.body).not.toMatch(/secret|private|23505|database-constraint|failureKind/);
    expect(JSON.parse(sink.mock.calls[0]![0])).toMatchObject({ event: 'request_failed', code: 'INTERNAL_ERROR', statusCode: 500, failureKind: 'database-constraint' });
  } finally { await app.close(); }
});
