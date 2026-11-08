import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPublicResultProjector } from '../../apps/api/src/presentation/public-results.js';
import { uniqueTargetSnapshot, validate005 } from '../helpers/iteration005-fixtures.js';

describe('analyst result projection shared by local and hosted reads', () => {
  it('keeps exact values while moving retained evidence into typed sections with global counts', async () => {
    const snapshot = uniqueTargetSnapshot(), result = validate005(snapshot).results[0]!, before = structuredClone(result);
    const projector = createPublicResultProjector(snapshot), row = await projector.row(result);
    expect(row.values).toEqual(result.values); expect(row.expression).toBe(result.expression);
    expect(row.counts.reads).toBe(result.factReads.length); expect(row.counts.origins).toBe(result.sources.length);
    expect(row).not.toHaveProperty('factReads'); expect(row).not.toHaveProperty('readKeys'); expect(row).not.toHaveProperty('sources');
    const reads = []; for await (const item of projector.items(result, 'reads')) reads.push(item);
    expect(reads.map(item => item.value)).toEqual(result.factReads); expect(result).toEqual(before);
  });
  it('uses opaque descriptors for large display fields without dropping their complete retained value', async () => {
    const snapshot = uniqueTargetSnapshot(), result = { ...validate005(snapshot).results[0]!, expression: 'x'.repeat(100000) };
    const full: unknown[] = [], descriptor = { valueRef: randomUUID(), byteLength: 100002, sha256: 'a'.repeat(64), mediaType: 'application/json' as const };
    const projector = createPublicResultProjector(snapshot, { bound: async value => {
      if (typeof value === 'string' && value.length > 1000) { full.push(value); return descriptor; } return value;
    } });
    expect((await projector.row(result)).expression).toEqual(descriptor); expect(full).toEqual([result.expression]);
  });
});
