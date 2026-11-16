import { createHash } from 'node:crypto';
import { Receiver } from '@upstash/qstash';
import type { AcceptedJobReference, JobDispatcher } from '../ports/job-dispatcher.js';
import { createOperationalLogger, type OperationalLogger, type ProviderFailureReason } from './operational-log.js';

export interface InternalSignatureVerifier {
  verify(input: { readonly signature: string; readonly body: string; readonly url: string }): Promise<boolean>;
}
export function isAcceptedJobReference(value: unknown): value is AcceptedJobReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 3 && entries.every(([key, item]) => ['sessionId', 'workspaceId', 'jobId'].includes(key)
    && typeof item === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item));
}
/** Provider text is bounded and reduced to fixed labels; it never enters logs or public errors. */
async function rejectionReason(result: Response): Promise<ProviderFailureReason> {
  if (result.status === 401 || result.status === 403) { await result.body?.cancel().catch(() => undefined); return 'access'; }
  if (result.status === 429) { await result.body?.cancel().catch(() => undefined); return 'rate-limit'; }
  if (result.status >= 500) { await result.body?.cancel().catch(() => undefined); return 'provider-error'; }
  const reader = result.body?.getReader(); if (!reader) return 'request-rejected';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const read = await reader.read(); if (read.done) break; size += read.value.byteLength; if (size > 4096) return 'request-rejected'; chunks.push(read.value); }
    const response: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    const error = response && typeof response === 'object' && 'error' in response && typeof response.error === 'string' ? response.error : '';
    if (/redact/i.test(error)) return 'redaction-invalid';
    if (/timeout/i.test(error)) return 'timeout-invalid';
    if (/flow.control|parallelism/i.test(error)) return 'flow-control-invalid';
    if (/retry|retries/i.test(error)) return 'retry-invalid';
    return 'request-rejected';
  } catch { return 'request-rejected'; }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
/** SQL/outbox account the entire four-delivery budget before invoking this transport. */
export class QstashDispatcher implements JobDispatcher {
  private readonly token: string;
  private readonly url: string;
  private readonly flowKey: string;
  constructor(options: { readonly publicApiOrigin: string; readonly token: string }, private readonly log: OperationalLogger = createOperationalLogger()) {
    const origin = new URL(options.publicApiOrigin);
    if (origin.origin !== options.publicApiOrigin || origin.protocol !== 'https:' || !options.token) throw new TypeError('Invalid QStash configuration');
    this.url = origin.origin + '/internal/jobs';
    this.flowKey = 'ce-cpu-' + createHash('sha256').update(origin.origin).digest('hex').slice(0, 24);
    this.token = options.token;
  }
  async dispatch(reference: AcceptedJobReference): Promise<void> {
    if (!isAcceptedJobReference(reference)) throw new TypeError('Expected accepted job references only');
    // The pinned SDK's publisher does not propagate AbortSignal. Use the documented REST boundary
    // so a hung provider request is actually aborted, keeping the outbox attempt uncertain.
    let result: Response;
    try { result = await fetch('https://qstash.upstash.io/v2/publish/' + this.url, { method:'POST',
      signal:AbortSignal.timeout(10_000), redirect:'error', body:JSON.stringify(reference), headers:{
        Authorization:'Bearer '+this.token, 'Content-Type':'application/json', 'Upstash-Method':'POST',
        'Upstash-Retries':'3','Upstash-Retry-Delay':'1000 * pow(2, retried)','Upstash-Timeout':'120s',
        'Upstash-Flow-Control-Key':this.flowKey,'Upstash-Flow-Control-Value':'parallelism=1',
        // The SDK emits singular "header"; live QStash rejects the REST docs' plural "headers".
        'Upstash-Deduplication-Id':reference.jobId,'Upstash-Redact-Fields':'body,header',
      } }); } catch (error) {
      this.failed(reference.jobId, error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout' : 'network-error'); throw error;
    }
    if(!result.ok){this.failed(reference.jobId, await rejectionReason(result), result.status);throw new Error('Queue acknowledgement was not confirmed');}
    let response: unknown;
    try { response = await result.json(); } catch { this.failed(reference.jobId, 'invalid-response', result.status); throw new Error('Queue acknowledgement was not confirmed'); }
    if (!response || typeof response !== 'object' || !('messageId' in response) || typeof response.messageId !== 'string' || !response.messageId) {
      this.failed(reference.jobId, 'invalid-response', result.status); throw new Error('Queue acknowledgement was not confirmed');
    }
  }
  private failed(jobId: string, providerReason: ProviderFailureReason, statusCode?: number): void {
    try { this.log('provider_failed', { jobId, providerOperation: 'qstash-publish', providerReason, ...(statusCode ? { statusCode } : {}) }); } catch { /* Diagnostics cannot change dispatch authority. */ }
  }
}
/** SDK verifies the unmodified body, exact configured public URL and current/next signing keys. */
export class QstashSignatureVerifier implements InternalSignatureVerifier {
  private readonly receiver: Receiver;
  constructor(currentSigningKey: string, nextSigningKey: string) {
    if (!currentSigningKey || !nextSigningKey) throw new TypeError('Internal signing keys are required');
    this.receiver = new Receiver({ currentSigningKey, nextSigningKey, devMode: false });
  }
  async verify(input: { readonly signature: string; readonly body: string; readonly url: string }): Promise<boolean> {
    try { return await this.receiver.verify({ ...input, clockTolerance: 0 }); }
    catch { return false; }
  }
}
