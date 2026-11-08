import { randomUUID } from 'node:crypto';
import type { AcceptedJobReference, JobDispatcher } from '../../apps/api/src/ports/job-dispatcher.js';

interface Gate { readonly entered: Promise<void>; readonly released: Promise<void>; enter(): void; release(): void }
/** Named, one-shot barriers coordinate races without sleeps. arm → waitUntilReached → release. */
export class ControlledBarriers {
  private readonly gates = new Map<string, Gate>();
  arm(name: string): void {
    if (this.gates.has(name)) throw new Error(`Barrier already armed: ${name}`);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    this.gates.set(name, { entered, released, enter, release });
  }
  async reach(name: string): Promise<void> {
    const gate = this.gates.get(name); if (!gate) return;
    gate.enter(); await gate.released;
    if (this.gates.get(name) === gate) this.gates.delete(name);
  }
  async waitUntilReached(name: string): Promise<void> {
    const gate = this.gates.get(name); if (!gate) throw new Error(`Barrier not armed: ${name}`);
    await gate.entered;
  }
  release(name: string): void { const gate = this.gates.get(name); if (!gate) throw new Error(`Barrier not armed: ${name}`); gate.release(); }
  releaseAll(): void { for (const gate of this.gates.values()) gate.release(); this.gates.clear(); }
}
export interface ControlledQueueMessage { readonly messageId: string; readonly reference: AcceptedJobReference }
/** Deliberately controlled provider transport, never a substitute for the PostgreSQL authority. */
export class ControlledQueue implements JobDispatcher {
  private readonly accepted: ControlledQueueMessage[] = [];
  private failure: 'before' | 'after' | undefined;
  readonly attempts: AcceptedJobReference[] = [];
  constructor(readonly barriers = new ControlledBarriers()) {}
  get messages(): readonly ControlledQueueMessage[] { return structuredClone(this.accepted); }
  failNextDispatch(point: 'before' | 'after'): void { this.failure = point; }
  async dispatch(reference: AcceptedJobReference): Promise<void> {
    const failure = this.failure; this.failure = undefined;
    const copy = structuredClone(reference);
    this.attempts.push(copy);
    await this.barriers.reach('queue.beforeDispatch');
    if (failure === 'before') throw new Error('CONTROLLED_QUEUE_REJECTED');
    this.accepted.push({ messageId: randomUUID(), reference: copy });
    await this.barriers.reach('queue.afterDispatch');
    if (failure === 'after') throw new Error('CONTROLLED_QUEUE_ACK_LOST');
  }
  /** Messages stay available for explicit duplicate/reordered deliveries, matching at-least-once transport. */
  async deliver(messageId: string, handler: (reference: AcceptedJobReference) => Promise<unknown>): Promise<void> {
    const message = this.accepted.find(item => item.messageId === messageId);
    if (!message) throw new Error('CONTROLLED_QUEUE_MESSAGE_NOT_FOUND');
    await this.barriers.reach('queue.beforeDelivery');
    await handler(structuredClone(message.reference));
    await this.barriers.reach('queue.afterDelivery');
  }
}
