import { createHash } from 'node:crypto';
import { Receiver } from '@upstash/qstash';
import type { AcceptedJobReference, JobDispatcher } from '../ports/job-dispatcher.js';

export interface InternalSignatureVerifier {
  verify(input: { readonly signature: string; readonly body: string; readonly url: string }): Promise<boolean>;
}
export function isAcceptedJobReference(value: unknown): value is AcceptedJobReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 3 && entries.every(([key, item]) => ['sessionId', 'workspaceId', 'jobId'].includes(key)
    && typeof item === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item));
}
/** SQL/outbox account the entire four-delivery budget before invoking this transport. */
export class QstashDispatcher implements JobDispatcher {
  private readonly token: string;
  private readonly url: string;
  private readonly flowKey: string;
  constructor(options: { readonly publicApiOrigin: string; readonly token: string }) {
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
    const result = await fetch('https://qstash.upstash.io/v2/publish/' + this.url, { method:'POST',
      signal:AbortSignal.timeout(10_000), redirect:'error', body:JSON.stringify(reference), headers:{
        Authorization:'Bearer '+this.token, 'Content-Type':'application/json', 'Upstash-Method':'POST',
        'Upstash-Retries':'3','Upstash-Retry-Delay':'1000 * pow(2, retried)','Upstash-Timeout':'120s',
        'Upstash-Flow-Control-Key':this.flowKey,'Upstash-Flow-Control-Value':'parallelism=1',
        'Upstash-Deduplication-Id':reference.jobId,'Upstash-Redact-Fields':'body,headers',
      } });
    if(!result.ok){await result.body?.cancel();throw new Error('Queue acknowledgement was not confirmed');}
    const response:unknown = await result.json();
    if (!response || typeof response !== 'object' || !('messageId' in response) || typeof response.messageId !== 'string' || !response.messageId) {
      throw new Error('Queue acknowledgement was not confirmed');
    }
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
