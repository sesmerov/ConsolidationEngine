import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ControlledBarriers, ControlledQueue } from '../helpers/controlled-queue.js';
import { ControlledObjects, ControlledObjectTransport } from '../helpers/controlled-objects.js';
import { ControlledClock, createHostedHarness } from '../helpers/hosted-harness.js';

describe('hosted test controls (provider doubles, not SQL mocks)', () => {
  it('records a delivery after lost acknowledgement and permits explicit duplicate delivery', async () => {
    const barriers = new ControlledBarriers(), queue = new ControlledQueue(barriers);
    const reference = { sessionId: randomUUID(), workspaceId: randomUUID(), jobId: randomUUID() };
    barriers.arm('queue.afterDispatch'); queue.failNextDispatch('after');
    const delivery = queue.dispatch(reference);
    const rejected = expect(delivery).rejects.toThrow('CONTROLLED_QUEUE_ACK_LOST');
    await barriers.waitUntilReached('queue.afterDispatch');
    expect(queue.messages).toHaveLength(1);
    barriers.release('queue.afterDispatch'); await rejected;
    const received: unknown[] = [];
    await queue.deliver(queue.messages[0]!.messageId, async message => { received.push(message); });
    await queue.deliver(queue.messages[0]!.messageId, async message => { received.push(message); });
    expect(received).toEqual([reference, reference]);
    queue.failNextDispatch('before'); await expect(queue.dispatch(reference)).rejects.toThrow('CONTROLLED_QUEUE_REJECTED');
    expect(queue.messages).toHaveLength(1);
  });
  it('retains uncertain physical writes under their predetermined key and verifies bytes/ownership', async () => {
    const transport = new ControlledObjectTransport();
    transport.failNext('put', 'after');
    await expect(transport.put('session/private-part', Uint8Array.of(1, 2, 3))).rejects.toThrow('CONTROLLED_PUT_ACK_LOST');
    expect(await transport.get('session/private-part')).toEqual(Uint8Array.of(1, 2, 3));
    await transport.put('session/private-part', Uint8Array.of(1, 2, 3));
    await expect(transport.put('session/private-part', Uint8Array.of(4))).rejects.toThrow('OBJECT_KEY_CONTENT_CONFLICT');
    await transport.remove('session/private-part'); expect(await transport.get('session/private-part')).toBeNull();
    const objects = new ControlledObjects(), owner = { sessionId: randomUUID(), workspaceId: randomUUID() };
    const reference = await objects.put(owner, Uint8Array.of(4, 5));
    await expect(objects.get({ ...owner, sessionId: randomUUID() }, reference)).rejects.toThrow('OBJECT_NOT_FOUND');
    objects.corrupt(owner, reference.objectId, Uint8Array.of(0, 0));
    await expect(objects.get(owner, reference)).rejects.toThrow('OBJECT_INTEGRITY');
  });
  it('uses an explicit clock and creates independently composed instances over one real isolated schema', async () => {
    const clock = new ControlledClock(100); clock.advance(99); expect(clock.now()).toBe(199);
    const harness = await createHostedHarness();
    const closed: string[] = [];
    try {
      // A lifecycle probe only: actual API routing/authentication is covered once the hosted composition is attached.
      const pair = await harness.createApis(async dependencies => ({ dependencies, async close() { closed.push(dependencies.instanceId); } }));
      expect(pair[0].dependencies.database).not.toBe(pair[1].dependencies.database);
      expect(pair[0].dependencies.database.schema).toBe(pair[1].dependencies.database.schema);
      expect(pair[0].dependencies.config.cursorSigningKey).toEqual(pair[1].dependencies.config.cursorSigningKey);
      expect(pair[0].dependencies.objectTransport).toBe(pair[1].dependencies.objectTransport);
      await expect(harness.createApis(async () => ({ async close() {} }))).rejects.toThrow('once');
    } finally { await harness.close(); }
    expect(closed.sort()).toEqual(['test-instance-1', 'test-instance-2']);
    await harness.close();
  });
});
