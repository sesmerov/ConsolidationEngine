import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CanonicalCodec, CANONICAL_BLOCK_MAX_BYTES } from '../../apps/api/src/hosted/canonical-codec.js';
import type { CanonicalBlockStore, CanonicalRef, CanonicalWriteContext } from '../../apps/api/src/hosted/canonical-codec.js';
import type { WorkspaceOwner } from '../../apps/api/src/ports/workspace-repository.js';

const owner = { sessionId: randomUUID(), workspaceId: randomUUID() }, context: CanonicalWriteContext = { operationId: randomUUID(), deadline: '2099-01-01T00:00:00Z' };
/** Serialization double only: real SQL ownership/quotas are exercised in hosted-transfers. */
class Blocks implements CanonicalBlockStore {
  readonly rows = new Map<string, { owner: WorkspaceOwner; ref: CanonicalRef; bytes: Uint8Array; dependencies: readonly CanonicalRef[] }>();
  async putCanonical(scope: WorkspaceOwner, bytes: Uint8Array, dependencies: readonly CanonicalRef[], _context: CanonicalWriteContext): Promise<CanonicalRef> {
    expect(bytes.byteLength).toBeLessThanOrEqual(CANONICAL_BLOCK_MAX_BYTES);
    const sha256 = createHash('sha256').update(bytes).digest('hex'), key = scope.sessionId + ':' + sha256, previous = this.rows.get(key); if (previous) return previous.ref;
    const ref: CanonicalRef = { resourceId: randomUUID(), manifestId: randomUUID(), codecVersion: 1, sha256, byteLength: bytes.byteLength };
    this.rows.set(key, { owner: scope, ref, bytes: Uint8Array.from(bytes), dependencies }); return ref;
  }
  async getCanonical(scope: WorkspaceOwner, ref: CanonicalRef): Promise<Uint8Array> {
    const row = this.rows.get(scope.sessionId + ':' + ref.sha256); if (!row || row.ref.resourceId !== ref.resourceId || row.owner.workspaceId !== scope.workspaceId) throw new Error('RESOURCE_NOT_FOUND'); return Uint8Array.from(row.bytes);
  }
}
describe('versioned canonical serialization (provider/SQL independent)', () => {
  it('roundtrips exact rationals, civil dates, null presence, Unicode, array order and source locators', async () => {
    const blocks = new Blocks(), codec = new CanonicalCodec(blocks), value = { rational: { numerator: '123456789012345678901234567890', denominator: '333333333333333333333' }, decimals: 'INF', unit: 'EUR', date: '2024-02-29', text: 'Banco \u0301  🚀', presence: ['implicit_null', 'explicit_null', 'value'], value: null, source: { sheet: '1.1', row: 12, column: 'F' } };
    const ref = await codec.put(owner, value, context); expect(ref.codecVersion).toBe(1); expect(await new CanonicalCodec(blocks).get(owner, ref)).toEqual(value);
    const reordered = Object.fromEntries(Object.entries(value).reverse()); expect(await codec.put(owner, reordered, context)).toEqual(ref); expect(blocks.rows.size).toBe(1);
  });
  it('chunks large arrays and strings without one stored block per fact or truncated text', async () => {
    const blocks = new Blocks(), codec = new CanonicalCodec(blocks), value = { facts: Array.from({ length: 10_000 }, (_, index) => ({ row: String(index), numerator: String(index) + '12345678901234567890', denominator: '3' })), description: '🚀\n"\\é'.repeat(120_000) };
    const ref = await codec.put(owner, value, context); expect(blocks.rows.size).toBeGreaterThan(3); expect(blocks.rows.size).toBeLessThan(100); expect(await codec.get(owner, ref)).toEqual(value);
    expect(JSON.stringify(ref).length).toBeLessThan(512);
  });
  it('shares unchanged content within its owner and does not reuse another visitor references', async () => {
    const blocks = new Blocks(), codec = new CanonicalCodec(blocks), catalog = { rows: Array.from({ length: 8000 }, (_, i) => ({ code: 'R' + i, expression: '{tC_01.00,r0010,c0010}=1' })) };
    const first = await codec.put(owner, catalog, context), count = blocks.rows.size; expect(await codec.put(owner, catalog, context)).toEqual(first); expect(blocks.rows.size).toBe(count);
    const other = { sessionId: randomUUID(), workspaceId: randomUUID() }, second = await codec.put(other, catalog, context); expect(second.resourceId).not.toBe(first.resourceId); await expect(codec.get(other, first)).rejects.toThrow('RESOURCE_NOT_FOUND');
  });
  it('rejects runtime objects, sparse arrays, nonfinite numbers, unsupported fields and cycles', async () => {
    const codec = new CanonicalCodec(new Blocks()), cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
    for (const invalid of [new Map(), new Set(), new Date(), 1n, Infinity, NaN, undefined, cycle, { hidden: undefined }, Array(2)]) await expect(codec.put(owner, invalid, context)).rejects.toThrow();
  });
  it('verifies stored bytes and codec version before decoding', async () => {
    const blocks = new Blocks(), codec = new CanonicalCodec(blocks), ref = await codec.put(owner, { text: 'sensible' }, context);
    const row = blocks.rows.get(owner.sessionId + ':' + ref.sha256)!; row.bytes = Uint8Array.from(Buffer.from('{}'));
    await expect(codec.get(owner, ref)).rejects.toThrow(/integrity/i); await expect(codec.get(owner, { ...ref, codecVersion: 2 } as unknown as CanonicalRef)).rejects.toThrow(/codec/i);
  });
});
