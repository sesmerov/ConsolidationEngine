import { expect, it } from 'vitest';
import type { JsonValue, PreviewBundle } from '@ce/contracts';
import { selectionHarness } from '../helpers/proposal-selection-harness.js';

it('bounds explanation pages by bytes without losing exact operands, and rejects an oversized exact item', async () => {
  const h = await selectionHarness(), key = `preview:${h.workspace.id}:${h.previewId}`, original = h.store.getRecord<PreviewBundle>(key)!;
  const target = original.proposals[0]!, value = 'ñ'.repeat(32767);
  // Explicit synthetic retained-evidence fixture; this does not claim numeric recalculation of text operands.
  const seed = (text: string) => ({ ...original, proposals: original.proposals.map(p => p.id !== target.id ? p : { ...p,
    calculation: { expression: p.calculation!.expression, reads: Array.from({ length: 60 }, (_, n) => ({ fact: { ...p.before!, coordinate: { ...p.before!.coordinate, dataType: 'text' as const, unit: '', decimals: '' }, presence: 'value' as const,
      normalizedValue: { kind: 'text' as const, value: text }, originalText: text, sourceLocator: { sheet: 'Trace', row: n + 1, column: 'A' } } })) },
  }) });
  h.store.putRecords([{ key, value: seed(value) as unknown as JsonValue }]);
  const endpoint = `/proposals/${target.id}/explanation/items?section=operands&limit=50`;
  const first = await h.getSelection(endpoint); expect(first.statusCode, first.body).toBe(200); expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(1024 * 1024);
  expect(first.json().items.length).toBeGreaterThan(0); expect(first.json().items.length).toBeLessThan(50); expect(first.json().nextCursor).toBeTruthy();
  const ids: string[] = [], all: any[] = []; let page = first.json();
  for (;;) { ids.push(...page.items.map((i: any) => i.itemId)); all.push(...page.items); if (!page.nextCursor) break; const response = await h.getSelection(endpoint + '&cursor=' + encodeURIComponent(page.nextCursor)); expect(response.statusCode).toBe(200); expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(1024 * 1024); page = response.json(); }
  expect(new Set(ids).size).toBe(60); expect(all).toHaveLength(60); expect(all.every(i => i.value.value === value)).toBe(true);
  h.store.putRecords([{ key, value: seed('ñ'.repeat(600_000)) as unknown as JsonValue }]);
  const tooBig = await h.getSelection(endpoint); expect(tooBig.statusCode).toBe(413); expect(tooBig.json().error.code).toBe('EXPANSION_LIMIT');
});

it('reports unavailable historical evidence without reconstructing reads from current facts', async () => {
  const h = await selectionHarness(), key = `preview:${h.workspace.id}:${h.previewId}`, original = h.store.getRecord<PreviewBundle>(key)!;
  const target = original.proposals[0]!;
  h.store.putRecords([{ key, value: { ...original, proposals: original.proposals.map(p => { const { calculation: _trace, ...without } = p; return p.id === target.id ? without : p; }) } as unknown as JsonValue }]);
  const response = await h.getSelection(`/proposals/${target.id}/explanation`); expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ evidenceState: 'unavailable', operandCount: 0 });
  expect(response.json()).not.toHaveProperty('sourceValue'); const operands = await h.getSelection(`/proposals/${target.id}/explanation/items?section=operands`); expect(operands.json().items).toEqual([]);
});
