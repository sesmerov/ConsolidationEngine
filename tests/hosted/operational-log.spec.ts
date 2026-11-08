import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createOperationalLogger } from '../../apps/api/src/hosted/operational-log.js';

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
