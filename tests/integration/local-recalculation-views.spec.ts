import { createHash } from 'node:crypto';
import type { JsonValue, LargeValueDescriptorDTO, PreviewBundle } from '@ce/contracts';
import { expect, it } from 'vitest';
import { selectionHarness } from '../helpers/proposal-selection-harness.js';
import { reviewHarness } from '../helpers/direction-review-harness.js';
import { collidingTargetsSnapshot } from '../helpers/iteration005-fixtures.js';

async function restore(h: Awaited<ReturnType<typeof reviewHarness>>, descriptor: LargeValueDescriptorDTO) {
  const parts: Buffer[] = [];
  for (let index = 0; index < Math.ceil(descriptor.byteLength / 131072); index++) {
    const response = await h.app.inject({ url: `${h.base}/values/${descriptor.valueRef}/parts/${index}`, headers: h.headers });
    expect(response.statusCode, response.body).toBe(200); expect(response.rawPayload.length).toBeLessThanOrEqual(131072);
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(response.headers['x-ce-part-sha256']); parts.push(response.rawPayload);
  }
  const bytes = Buffer.concat(parts); expect(bytes.length).toBe(descriptor.byteLength); expect(createHash('sha256').update(bytes).digest('hex')).toBe(descriptor.sha256);
  return JSON.parse(bytes.toString());
}
it('keeps local legacy pages while compact review pages cap at 50 and retain exact candidate descriptions', async () => {
  const fixture = collidingTargetsSnapshot(51), text = 'á'.repeat(600000);
  const content = { ...fixture.content, catalog: { ...fixture.content.catalog, records: fixture.content.catalog.records.map((record, index) => index ? record : { ...record, originalFields: { ...record.originalFields, Description: text } }) } };
  const h = await reviewHarness({ content }), summary = await h.ready(), suffix = '/' + summary.id;
  const legacy = await h.get(suffix + '/rows?limit=200'); expect(legacy.statusCode, legacy.body).toBe(200); expect(legacy.json().items).toHaveLength(51);
  expect((await h.get(suffix + '/rows?compact=true&limit=51')).statusCode).toBe(400);
  const first = await h.get(suffix + '/rows?compact=true'); expect(first.statusCode, first.body).toBe(200); expect(first.json().items).toHaveLength(50);
  expect((await h.get(suffix + '/rows?compact=true&cursor=' + encodeURIComponent(first.json().nextCursor))).json().items).toHaveLength(1);
  const groups = (await h.get(suffix + '/groups?compact=true')).json(), groupId = groups.items[0].groupId;
  const candidates = await h.get(`${suffix}/groups/${groupId}/candidates?compact=true`); expect(candidates.statusCode, candidates.body).toBe(200); expect(candidates.json().items).toHaveLength(50);
  const candidate = candidates.json().items.find((row: { code: string }) => row.code === 'PRODUCER_001');
  const detail = await h.get(`${suffix}/groups/${groupId}/candidates/${candidate.instanceId}?compact=true`); expect(detail.statusCode, detail.body).toBe(200); expect(Buffer.byteLength(detail.body)).toBeLessThanOrEqual(1048576);
  const descriptor = detail.json().descriptions as LargeValueDescriptorDTO; expect(descriptor.valueRef).toBeTruthy(); expect((await restore(h, descriptor))[0].description).toBe(text);
  await h.edit(summary.id, 1, [{ op: 'omitAll' }]);
  expect((await h.app.inject({ url: `${h.base}/values/${descriptor.valueRef}/parts/0`, headers: h.headers })).statusCode).not.toBe(200);
});

it('pages compact proposal evidence and reconstructs oversized exact items without truncation', async () => {
  const h = await selectionHarness(), key = `preview:${h.workspace.id}:${h.previewId}`, original = h.store.getRecord<PreviewBundle>(key)!, proposal = original.proposals[0]!, text = 'ñ'.repeat(600000);
  // Synthetic retained trace proves transport fidelity; it does not enable text recalculation.
  const trace = { ...original, proposals: original.proposals.map(row => row.id !== proposal.id ? row : { ...row, calculation: { expression: text,
    reads: Array.from({ length: 60 }, (_, index) => ({ fact: { ...proposal.before!, coordinate: { ...proposal.before!.coordinate, dataType: 'text', unit: '', decimals: '' },
      presence: 'value', normalizedValue: { kind: 'text', value: index ? 'x'.repeat(26000) : text }, sourceLocator: { sheet: 'Trace', row: index + 1, column: 'A' } } })) } }) };
  h.store.putRecords([{ key, value: trace as unknown as JsonValue }]);
  expect((await h.getSelection('/rows?limit=200')).statusCode).toBe(200); expect((await h.getSelection('/rows?compact=true&limit=51')).statusCode).toBe(400);
  const suffix = `/proposals/${proposal.id}/explanation`, detail = await h.getSelection(suffix + '?compact=true');
  expect(detail.statusCode, detail.body).toBe(200); expect((await restore(h, detail.json())).expression).toBe(text);
  const endpoint = suffix + '/items?compact=true&section=operands', first = await h.getSelection(endpoint);
  expect(first.statusCode, first.body).toBe(200); expect(first.json().items.length).toBeLessThan(50); expect(first.json().items.length).toBeGreaterThan(0); expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(1048576);
  const descriptor = first.json().items[0] as LargeValueDescriptorDTO; expect((await restore(h, descriptor)).value.value).toBe(text);
  const second = await h.getSelection(endpoint + '&cursor=' + encodeURIComponent(first.json().nextCursor)); expect(second.json().items).toHaveLength(60 - first.json().items.length); expect(second.json().nextCursor).toBeNull();
  expect(Buffer.byteLength(second.body)).toBeLessThanOrEqual(1048576);
  const normal = [...first.json().items.slice(1), ...second.json().items]; expect(new Set(normal.map((item: { itemId: string }) => item.itemId)).size).toBe(59);
  expect(normal.every((item: { value: { value: string } }) => item.value.value === 'x'.repeat(26000))).toBe(true);
  await h.editSelection([{ op: 'clear' }]);
  expect((await h.getSelection(endpoint + '&cursor=' + encodeURIComponent(first.json().nextCursor))).statusCode).toBe(400);
  expect((await h.app.inject({ url: `${h.base}/values/${descriptor.valueRef}/parts/0`, headers: h.headers })).statusCode).not.toBe(200);
});
