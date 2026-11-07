import { describe, expect, it } from 'vitest';
import { iterationSnapshot } from '../helpers/iteration004-fixtures.js';
import { selectionHarness } from '../helpers/proposal-selection-harness.js';

describe('recorded proposal explanation and dependency pages', () => {
  it('reads the recalculated predecessor value and distinguishes direct dependencies from transitive closure', async () => {
    const snapshot = iterationSnapshot([
      { code: 'A', expression: '{tT,r0010,c0010}=10' },
      { code: 'B', expression: '{tT,r0020,c0010}={tT,r0010,c0010}+20' },
      { code: 'C', expression: '{tT,r0030,c0010}={tT,r0020,c0010}+30' },
    ], ['0010', '0020', '0030']);
    const h = await selectionHarness(snapshot), rows = (await h.getSelection('/rows')).json().items as { id: string; code: string }[];
    const b = rows.find(r => r.code === 'B')!, c = rows.find(r => r.code === 'C')!;
    const explanation = await h.getSelection(`/proposals/${b.id}/explanation`); expect(explanation.statusCode, explanation.body).toBe(200);
    expect(explanation.json()).toMatchObject({ evidenceState: 'recorded', operandCount: 1, exactNominal: { numerator: '30', denominator: '1' } });
    const operands = (await h.getSelection(`/proposals/${b.id}/explanation/items?section=operands`)).json();
    expect(operands.items[0]).toMatchObject({ originKind: 'proposal', fromProposalCode: 'A', value: { numerator: '10', denominator: '1' } });
    await h.editSelection([{ op: 'clear' }]); await h.editSelection([{ op: 'set', proposalId: c.id, selected: true }]);
    expect((await h.getSelection()).json()).toMatchObject({ selectedCount: 1, requiredCount: 2, complete: false });
    const direct = (await h.getSelection(`/proposals/${c.id}/dependencies?scope=missing`)).json();
    expect(direct).toMatchObject({ total: 1, predecessorCount: 1, requiredPredecessorCount: 1 }); expect(direct.items[0].code).toBe('B');
    expect((await h.getSelection('/rows?scope=missing')).json().items.map((r: any) => r.code)).toEqual(['A', 'B']);
    const rejected = await h.applySelection(await h.applicationBody()); expect(rejected.statusCode).toBe(409);
    expect(h.store.current(h.workspace.id)?.versionId).toBe(h.configuredSnapshot.versionId);
  });
  it('paginates more than fifty operands and direct predecessors without arrays nested in rows', async () => {
    const rows = Array.from({ length: 52 }, (_, i) => String((i + 1) * 10).padStart(4, '0'));
    const snapshot = iterationSnapshot([
      ...rows.slice(0, 51).map((row, i) => ({ code: 'P' + String(i).padStart(2, '0'), expression: `{tT,r${row},c0010}=${i + 1}` })),
      { code: 'TOTAL', expression: `{tT,r${rows[51]},c0010}=` + rows.slice(0, 51).map(row => `{tT,r${row},c0010}`).join('+') },
    ], rows);
    const h = await selectionHarness(snapshot), page = (await h.getSelection('/rows?code=TOTAL')).json(), row = page.items[0];
    expect(row.predecessorCount).toBe(51); expect(row).not.toHaveProperty('predecessorIds'); expect(row).not.toHaveProperty('calculation');
    const first = (await h.getSelection(`/proposals/${row.id}/dependencies`)).json(); expect(first.items).toHaveLength(50); expect(first.total).toBe(51);
    const last = (await h.getSelection(`/proposals/${row.id}/dependencies?cursor=${encodeURIComponent(first.nextCursor)}`)).json(); expect(last.items).toHaveLength(1);
    const operands = (await h.getSelection(`/proposals/${row.id}/explanation/items?section=operands`)).json(); expect(operands.items).toHaveLength(50);
    const tail = (await h.getSelection(`/proposals/${row.id}/explanation/items?section=operands&cursor=${encodeURIComponent(operands.nextCursor)}`)).json(); expect(tail.items).toHaveLength(1);
    await h.editSelection([{ op: 'clear' }]); expect((await h.getSelection(`/proposals/${row.id}/dependencies?cursor=${encodeURIComponent(first.nextCursor)}`)).statusCode).toBe(400);
  });
});
