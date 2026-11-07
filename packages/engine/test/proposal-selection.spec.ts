import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PreviewBundle, ProposalDTO } from '@ce/contracts';
import { WorkBudget } from '../src/execution/budget.js';
import { selectionClosureHash } from '../src/recalculation/apply-candidate.js';
import { createProposalSelection, editProposalSelection, selectedProposalIds, selectionBit, validateSelectionMask } from '../src/recalculation/proposal-selection.js';

function bundle(count = 51): PreviewBundle {
  const id = randomUUID(), ids = Array.from({ length: count }, () => randomUUID());
  const proposals = ids.map((id, i) => ({ id, previewId: '', code: `R${i}`, targetKey: `cell${i}`, state: 'available',
    before: { coordinate: { contextId: i % 2 ? 'second' : 'first', tableCode: 'T' } },
    after: { normalizedValue: { numerator: '1', denominator: '1' }, originalText: '1', unit: 'EUR', decimals: '2' },
    predecessorIds: i === count - 1 ? [ids[0]!] : [], binding: {}, variantIds: [], diagnostics: [], sources: [], readKeys: [], metadataReads: [],
  } as unknown as ProposalDTO));
  return { preview: { id, baseVersionId: randomUUID(), profileId: 'profile', policyId: 'half-even-v1', state: 'ready', createdAt: new Date().toISOString(),
    proposalIds: ids, diagnostics: [], graphSummary: { nodes: count, edges: 1, order: [], conflicts: [], cycles: [], blocked: 0 } },
    proposals: proposals.map(p => ({ ...p, previewId: id })) };
}
describe('compact proposal selection', () => {
  it('initializes all available proposals and keeps JSON masks without duplicated proposal IDs', () => {
    const b = bundle(), p = createProposalSelection(b, 'available');
    expect(p.selectedCount).toBe(51); expect(p.complete).toBe(true); expect(selectedProposalIds(b, p)).toEqual(b.proposals.map(x => x.id));
    expect(JSON.stringify(p)).not.toContain(b.proposals[0]!.id);
    expect(p.closureHash).toBe(selectionClosureHash(b.preview, b.proposals.map(x => x.id)));
    expect(() => validateSelectionMask(p.selected, 51)).not.toThrow();
  });
  it('preserves explicit deselection and reports a missing ancestor rather than adding it', () => {
    const b = bundle(), initial = createProposalSelection(b, 'available');
    const p = editProposalSelection(b, initial, [{ op: 'set', proposalId: b.proposals[0]!.id, selected: false }]);
    expect(p.selectedCount).toBe(50); expect(p.requiredCount).toBe(1); expect(p.complete).toBe(false);
    expect(selectionBit(p.selected, 0)).toBe(false); expect(selectionBit(p.required, 0)).toBe(true);
    expect(initial.selectedCount).toBe(51); expect(editProposalSelection(b, p, [{ op: 'clear' }]).selectedCount).toBe(0);
  });
  it('selects all matching pages while preserving selections outside the context filter', () => {
    const b = bundle(), empty = createProposalSelection(b, 'empty');
    const first = editProposalSelection(b, empty, [{ op: 'set', proposalId: b.proposals[1]!.id, selected: true }]);
    const next = editProposalSelection(b, first, [{ op: 'selectMatching', filter: { contextId: 'first' } }]);
    expect(next.selectedCount).toBe(27); expect(selectionBit(next.selected, 1)).toBe(true);
    expect(editProposalSelection(b, next, [{ op: 'selectMatching', filter: { code: 'missing' } }]).selectedCount).toBe(27);
  });
  it('computes transitively and does not count a direct predecessor twice', () => {
    const b = bundle(3); const chain = { ...b, proposals: b.proposals.map((p, i) => ({ ...p, predecessorIds: i ? [b.proposals[i - 1]!.id] : [] })) };
    const p = editProposalSelection(chain, createProposalSelection(chain, 'empty'), [{ op: 'set', proposalId: chain.proposals[2]!.id, selected: true }]);
    expect(p.requiredCount).toBe(2); expect(selectionBit(p.required, 0)).toBe(true); expect(selectionBit(p.required, 1)).toBe(true);
  });
  it('rejects unknown, blocked, duplicate edits and malformed masks and checks the work budget', () => {
    const b = bundle(), p = createProposalSelection(b, 'empty'), id = b.proposals[0]!.id;
    expect(() => editProposalSelection(b, p, [{ op: 'set', proposalId: randomUUID(), selected: true }])).toThrow();
    expect(() => editProposalSelection(b, p, [{ op: 'set', proposalId: id, selected: true }, { op: 'set', proposalId: id, selected: false }])).toThrow();
    expect(() => createProposalSelection(b, 'available', new WorkBudget({ limits: { instances: 1 } }))).toThrow();
    expect(() => validateSelectionMask({ ...p.selected, blocks: ['////'] }, 51)).toThrow();
    const blocked = { ...b, proposals: b.proposals.map((r, i) => i ? r : { ...r, state: 'blocked' as const, after: undefined }) } as PreviewBundle;
    expect(() => editProposalSelection(blocked, createProposalSelection(blocked, 'empty'), [{ op: 'set', proposalId: id, selected: true }])).toThrow();
  });
});
