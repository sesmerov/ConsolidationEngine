/// <reference types="node" />
import type { PreviewBundle, ProposalDTO, ProposalSelectionFilterDTO, ProposalSelectionOperationDTO } from '@ce/contracts';
import { WorkBudget, WorkLimitError } from '../execution/budget.js';
import { selectionClosureHash } from './apply-candidate.js';
export const SELECTION_BLOCK_BYTES = 4096;
export interface SelectionMask { readonly length: number; readonly blocks: readonly string[] }
export interface ProposalSelectionProjection {
  readonly cardinality: number; readonly available: SelectionMask; readonly selected: SelectionMask; readonly required: SelectionMask;
  readonly availableCount: number; readonly selectedCount: number; readonly requiredCount: number; readonly complete: boolean; readonly closureHash: string;
}
export class ProposalSelectionError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'PROPOSAL_SELECTION_NOT_APPLICABLE', message = code) { super(message); }
}
function fail(): never { throw new ProposalSelectionError('INVALID_REQUEST'); }
export function validateSelectionMask(mask: SelectionMask, length = mask.length): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > 1_000_000 || mask.length !== length || !Array.isArray(mask.blocks)) fail();
  const bytes = Math.ceil(length / 8), blocks = Math.ceil(bytes / SELECTION_BLOCK_BYTES);
  if (mask.blocks.length !== blocks) fail();
  for (let i = 0; i < blocks; i++) {
    const text = mask.blocks[i]!, data = Buffer.from(text, 'base64'), expected = Math.min(SELECTION_BLOCK_BYTES, bytes - i * SELECTION_BLOCK_BYTES);
    if (data.length !== expected || data.toString('base64') !== text) fail();
    if (i === blocks - 1 && length % 8 && data.at(-1)! >> (length % 8)) fail();
  }
}
function unpack(mask: SelectionMask): Buffer { validateSelectionMask(mask); return Buffer.concat(mask.blocks.map(text => Buffer.from(text, 'base64'))); }
function pack(data: Buffer, length: number, previous?: SelectionMask): SelectionMask {
  const blocks: string[] = []; for (let start = 0; start < data.length; start += SELECTION_BLOCK_BYTES) {
    const text = data.subarray(start, start + SELECTION_BLOCK_BYTES).toString('base64'), i = blocks.length; blocks.push(previous?.blocks[i] === text ? previous.blocks[i]! : text);
  } return { length, blocks };
}
const bit = (data: Uint8Array, n: number) => !!(data[n >>> 3]! & (1 << (n & 7)));
const set = (data: Uint8Array, n: number, value: boolean) => { data[n >>> 3] = value ? data[n >>> 3]! | (1 << (n & 7)) : data[n >>> 3]! & ~(1 << (n & 7)); };
/** A page reads at most one 4 KiB block for any ordinal; callers may reuse a decoded page-local block. */
export function selectionBit(mask: SelectionMask, ordinal: number): boolean {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= mask.length) return false;
  const byte = ordinal >>> 3, block = Buffer.from(mask.blocks[Math.floor(byte / SELECTION_BLOCK_BYTES)]!, 'base64');
  return !!(block[byte % SELECTION_BLOCK_BYTES]! & (1 << (ordinal & 7)));
}
export function selectionMaskReader(mask: SelectionMask): (ordinal: number) => boolean {
  let current = -1, data: Buffer = Buffer.alloc(0);
  return n => { if (n < 0 || n >= mask.length) return false; const block = Math.floor((n >>> 3) / SELECTION_BLOCK_BYTES);
    if (block !== current) { current = block; data = Buffer.from(mask.blocks[block]!, 'base64'); }
    return !!(data[(n >>> 3) % SELECTION_BLOCK_BYTES]! & (1 << (n & 7))); };
}
export function proposalMatchesFilter(row: ProposalDTO, filter: ProposalSelectionFilterDTO): boolean {
  const cell = row.before?.coordinate;
  return (!filter.status || row.state === filter.status) && (!filter.code || row.code.toLowerCase().includes(filter.code.toLowerCase()))
    && (!filter.table || (cell?.tableCode ?? row.binding.tableCode) === filter.table)
    && (!filter.contextId || (cell?.contextId ?? row.binding.contextId) === filter.contextId);
}
function project(bundle: PreviewBundle, selected: Buffer, budget: WorkBudget, previous?: ProposalSelectionProjection): ProposalSelectionProjection {
  const count = bundle.proposals.length; if (count > 1_000_000) throw new WorkLimitError('RESOURCE_LIMIT', 'Selection cardinality');
  const available = Buffer.alloc(Math.ceil(count / 8)), required = Buffer.alloc(available.length), visited = Buffer.alloc(available.length);
  const byId = new Map<string, number>(), selectedIds: string[] = [], requiredIds: string[] = [], pending: number[] = [];
  let availableCount = 0;
  for (let n = 0; n < count; n++) { budget.consume('instances'); const row = bundle.proposals[n]!;
    budget.consume('edges', row.predecessorIds.length);
    if (byId.has(row.id) || row.previewId !== bundle.preview.id) fail(); byId.set(row.id, n);
    const usable = row.state === 'available' && !!row.after && !!row.before; set(available, n, usable); if (usable) availableCount++;
    if (bit(selected, n)) { if (!usable) throw new ProposalSelectionError('PROPOSAL_SELECTION_NOT_APPLICABLE'); selectedIds.push(row.id); pending.push(n); }
  }
  while (pending.length) { budget.check(); const n = pending.pop()!; if (bit(visited, n)) continue; set(visited, n, true);
    for (const id of bundle.proposals[n]!.predecessorIds) { budget.check(); const ancestor = byId.get(id); if (ancestor === undefined) fail();
      if (!bit(available, ancestor)) throw new ProposalSelectionError('PROPOSAL_SELECTION_NOT_APPLICABLE');
      if (!bit(selected, ancestor) && !bit(required, ancestor)) { set(required, ancestor, true); requiredIds.push(id); }
      if (!bit(visited, ancestor)) pending.push(ancestor);
    }
  }
  return { cardinality: count, available: pack(available, count, previous?.available), selected: pack(selected, count, previous?.selected), required: pack(required, count, previous?.required),
    availableCount, selectedCount: selectedIds.length, requiredCount: requiredIds.length, complete: requiredIds.length === 0, closureHash: selectionClosureHash(bundle.preview, selectedIds, requiredIds) };
}
export function createProposalSelection(bundle: PreviewBundle, seed: 'empty' | 'available', budget = new WorkBudget()): ProposalSelectionProjection {
  if (bundle.proposals.length > 1_000_000) throw new WorkLimitError('RESOURCE_LIMIT', 'Selection cardinality');
  const selected = Buffer.alloc(Math.ceil(bundle.proposals.length / 8));
  if (seed === 'available') for (let n = 0; n < bundle.proposals.length; n++) { budget.check(); const row = bundle.proposals[n]!; if (row.state === 'available' && row.before && row.after) set(selected, n, true); }
  return project(bundle, selected, budget);
}
export function editProposalSelection(bundle: PreviewBundle, prior: ProposalSelectionProjection, operations: readonly ProposalSelectionOperationDTO[], budget = new WorkBudget()): ProposalSelectionProjection {
  if (prior.cardinality !== bundle.proposals.length || !operations.length || operations.length > 200) fail();
  validateSelectionMask(prior.selected, prior.cardinality); validateSelectionMask(prior.available, prior.cardinality); validateSelectionMask(prior.required, prior.cardinality);
  const selected = unpack(prior.selected), global = operations.filter(op => op.op !== 'set');
  if (global.length && operations.length !== 1) fail();
  if (operations[0]!.op === 'clear') selected.fill(0);
  else if (operations[0]!.op === 'selectMatching') { const filter = operations[0]!.filter; for (let n = 0; n < bundle.proposals.length; n++) { budget.check(); const row = bundle.proposals[n]!; if (row.state === 'available' && proposalMatchesFilter(row, filter)) set(selected, n, true); } }
  else {
    const changes = new Map<string, boolean>(); for (const op of operations) { if (op.op !== 'set' || changes.has(op.proposalId)) fail(); changes.set(op.proposalId, op.selected); }
    for (let n = 0; n < bundle.proposals.length; n++) { budget.check(); const row = bundle.proposals[n]!, value = changes.get(row.id); if (value === undefined) continue;
      if (row.state !== 'available' || !row.before || !row.after) throw new ProposalSelectionError('PROPOSAL_SELECTION_NOT_APPLICABLE'); set(selected, n, value); changes.delete(row.id);
    } if (changes.size) fail();
  }
  return project(bundle, selected, budget, prior);
}
export function selectedProposalIds(bundle: PreviewBundle, projection: ProposalSelectionProjection, budget = new WorkBudget()): string[] {
  if (projection.cardinality !== bundle.proposals.length) fail(); validateSelectionMask(projection.selected, bundle.proposals.length);
  const contains = selectionMaskReader(projection.selected), result: string[] = [];
  for (let n = 0; n < bundle.proposals.length; n++) { budget.check(); if (contains(n)) result.push(bundle.proposals[n]!.id); } return result;
}
