import type { FastifyInstance } from 'fastify';
import { isTerminalJob, type JobDTO } from '@ce/contracts';
import type { AcceptedJobReference } from '../ports/job-dispatcher.js';
import { isAcceptedJobReference, type InternalSignatureVerifier } from '../hosted/qstash-dispatcher.js';

export type InternalRunOutcome = { readonly state: 'terminal'; readonly job: JobDTO }
  | { readonly state: 'busy'; readonly retryAfterMs: number };
export interface InternalJobDependencies {
  readonly publicApiOrigin: string;
  readonly verifier: InternalSignatureVerifier;
  readonly run: (reference: AcceptedJobReference) => Promise<InternalRunOutcome>;
}
/** This encapsulated parser preserves signed bytes; it never uses the visitor's bearer as internal authority. */
export function registerInternalJobs(app: FastifyInstance, dependencies: InternalJobDependencies): void {
  app.register(async scope => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 4096 }, (_request, bytes, done) => done(null, bytes));
    scope.post('/internal/jobs', { bodyLimit: 4096 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const signature = request.headers['upstash-signature'];
      if (typeof signature !== 'string' || signature.length > 8192 || !Buffer.isBuffer(request.body)) return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(request.body); }
      catch { return reply.code(400).send({ error: 'INVALID_MESSAGE' }); }
      const url = dependencies.publicApiOrigin + request.raw.url;
      if (!await dependencies.verifier.verify({ signature, body: raw, url })) return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      let reference: unknown;
      try { reference = JSON.parse(raw); } catch { return reply.code(400).send({ error: 'INVALID_MESSAGE' }); }
      if (!isAcceptedJobReference(reference)) return reply.code(400).send({ error: 'INVALID_MESSAGE' });
      // No 2xx is emitted until the runner has awaited worker termination and durable final publication.
      const outcome = await dependencies.run(reference);
      if (outcome.state === 'busy') return reply.header('Retry-After', String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000))))
        .code(503).send({ status: 'busy' });
      if (!isTerminalJob(outcome.job.status)) throw new Error('Worker returned a nonterminal result');
      return { status: 'terminal' };
    });
  });
}
