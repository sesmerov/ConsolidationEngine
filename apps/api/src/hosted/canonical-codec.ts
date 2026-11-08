import { createHash } from 'node:crypto';
import type { JsonValue } from '@ce/contracts';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import { canonicalStringify } from '../session/canonical-state.js';

export const CANONICAL_CODEC_VERSION = 1 as const;
export const CANONICAL_BLOCK_MAX_BYTES = 256 * 1024;
const INLINE_BUDGET = CANONICAL_BLOCK_MAX_BYTES - 4096, FANOUT = 64;
export interface CanonicalRef {
  readonly resourceId: string; readonly manifestId: string; readonly codecVersion: typeof CANONICAL_CODEC_VERSION;
  readonly sha256: string; readonly byteLength: number;
}
export interface CanonicalWriteContext {
  readonly operationId: string; readonly jobId?: string; readonly attemptId?: string; readonly fence?: string | number;
  readonly deadline: string; readonly cancelled?: () => boolean;
}
/** Only worker/domain services use this port; public routes query bounded projections. */
export interface CanonicalBlockStore {
  putCanonical(owner: WorkspaceOwner, bytes: Uint8Array, dependencies: readonly CanonicalRef[], context: CanonicalWriteContext): Promise<CanonicalRef>;
  getCanonical(owner: WorkspaceOwner, reference: CanonicalRef): Promise<Uint8Array>;
}
type Entry = { readonly value: JsonValue } | { readonly ref: CanonicalRef };
type Envelope =
  | { readonly codecVersion: 1; readonly type: 'json'; readonly value: JsonValue }
  | { readonly codecVersion: 1; readonly type: 'array-items'; readonly items: readonly Entry[] }
  | { readonly codecVersion: 1; readonly type: 'object-items'; readonly items: readonly (readonly [Entry, Entry])[] }
  | { readonly codecVersion: 1; readonly type: 'array' | 'object' | 'string'; readonly children: readonly CanonicalRef[] };

function plainKeys(value: object): string[] {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Object.getOwnPropertySymbols(value).length) throw new TypeError('Canonical data must contain plain JSON objects.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Canonical data cannot contain hidden properties or accessors.');
  return Object.keys(descriptors).sort();
}
function* tokens(value: unknown, ancestors: WeakSet<object>): Generator<string> {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { yield JSON.stringify(value); return; }
  if (typeof value === 'string') {
    yield '"';
    for (let offset = 0; offset < value.length;) { let end = Math.min(offset + 32_000, value.length); if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--; yield JSON.stringify(value.slice(offset, end)).slice(1, -1); offset = end; }
    yield '"'; return;
  }
  if (typeof value !== 'object' || value === null) throw new TypeError('Canonical data must be finite JSON; BigInt, undefined and runtime objects are not supported.');
  if (ancestors.has(value)) throw new TypeError('Cyclic canonical data.'); ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Canonical arrays cannot contain symbols.');
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) if (name !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(name) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) throw new TypeError('Canonical arrays cannot contain hidden properties or accessors.');
      yield '[';
      for (let index = 0; index < value.length; index++) { if (!Object.hasOwn(value, index)) throw new TypeError('Sparse arrays are not canonical JSON.'); if (index) yield ','; yield* tokens(value[index], ancestors); }
      yield ']';
    } else {
      yield '{'; let index = 0;
      for (const key of plainKeys(value)) { if (index++) yield ','; yield* tokens(key, ancestors); yield ':'; yield* tokens((value as Record<string, unknown>)[key], ancestors); }
      yield '}';
    }
  } finally { ancestors.delete(value); }
}
/** Stop as soon as a subtree needs segmentation; never stringify an entire large snapshot. */
function smallJson(value: unknown, limit: number): string | null {
  if (typeof value === 'string' && value.length > limit) return null;
  const parts: string[] = []; let bytes = 0;
  for (const token of tokens(value, new WeakSet())) { bytes += Buffer.byteLength(token, 'utf8'); if (bytes > limit) return null; parts.push(token); }
  return parts.join('');
}
function reference(value: unknown): value is CanonicalRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(',') === 'byteLength,codecVersion,manifestId,resourceId,sha256'
    && item['codecVersion'] === 1 && typeof item['resourceId'] === 'string' && typeof item['manifestId'] === 'string'
    && typeof item['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(item['sha256']) && Number.isSafeInteger(item['byteLength']) && (item['byteLength'] as number) > 0 && (item['byteLength'] as number) <= CANONICAL_BLOCK_MAX_BYTES;
}
function check(context?: Pick<CanonicalWriteContext, 'deadline' | 'cancelled'>): void {
  if (context && (context.cancelled?.() || !Number.isFinite(Date.parse(context.deadline)) || Date.now() >= Date.parse(context.deadline))) throw new Error('Canonical work cancelled or deadline exceeded.');
}

/** Bounded immutable blocks; arrays retain order, object keys are canonical, numerical strings are never converted. */
export class CanonicalCodec {
  constructor(private readonly blocks: CanonicalBlockStore) {}
  async put(owner: WorkspaceOwner, value: unknown, context: CanonicalWriteContext): Promise<CanonicalRef> {
    const active = new WeakSet<object>();
    const write = async (envelope: Envelope): Promise<CanonicalRef> => {
      check(context); const bytes = Buffer.from(canonicalStringify(envelope)); if (bytes.length > CANONICAL_BLOCK_MAX_BYTES) throw new Error('Canonical block exceeds its byte budget.');
      const refs = envelope.type === 'json' ? [] : 'children' in envelope ? envelope.children : envelope.items.flatMap(item => Array.isArray(item) ? item.flatMap(entry => 'ref' in entry ? [entry.ref] : []) : 'ref' in item ? [item.ref] : []);
      return this.blocks.putCanonical(owner, bytes, refs, context);
    };
    const branch = async (type: 'array' | 'object' | 'string', references: readonly CanonicalRef[]): Promise<CanonicalRef> => {
      let children = [...references]; while (children.length > FANOUT) { const parents: CanonicalRef[] = []; for (let offset = 0; offset < children.length; offset += FANOUT) parents.push(await write({ codecVersion: 1, type, children: children.slice(offset, offset + FANOUT) })); children = parents; }
      return write({ codecVersion: 1, type, children });
    };
    const entry = async (value: unknown): Promise<Entry> => { const small = smallJson(value, INLINE_BUDGET / 2); return small === null ? { ref: await encode(value) } : { value: JSON.parse(small) as JsonValue }; };
    const encode = async (item: unknown): Promise<CanonicalRef> => {
      check(context); const small = smallJson(item, INLINE_BUDGET); if (small !== null) return write({ codecVersion: 1, type: 'json', value: JSON.parse(small) as JsonValue });
      if (typeof item === 'string') {
        const refs: CanonicalRef[] = [];
        for (let offset = 0; offset < item.length;) { let end = Math.min(offset + 32_000, item.length); if (end < item.length && /[\uD800-\uDBFF]/.test(item[end - 1]!)) end--; refs.push(await encode(item.slice(offset, end))); offset = end; }
        return branch('string', refs);
      }
      if (!item || typeof item !== 'object') throw new TypeError('Unsupported canonical value.');
      if (active.has(item)) throw new TypeError('Cyclic canonical data.'); active.add(item);
      try {
        const refs: CanonicalRef[] = [];
        if (Array.isArray(item)) {
          let items: Entry[] = [], bytes = 128;
          for (let index = 0; index < item.length; index++) {
            if (!Object.hasOwn(item, index)) throw new TypeError('Sparse arrays are not canonical JSON.');
            const encoded = await entry(item[index]), size = Buffer.byteLength(canonicalStringify(encoded)) + 1;
            if (bytes + size > INLINE_BUDGET && items.length) { refs.push(await write({ codecVersion: 1, type: 'array-items', items })); items = []; bytes = 128; }
            items.push(encoded); bytes += size;
          }
          if (items.length) refs.push(await write({ codecVersion: 1, type: 'array-items', items })); return branch('array', refs);
        }
        let items: [Entry, Entry][] = [], bytes = 128;
        for (const key of plainKeys(item)) {
          const pair: [Entry, Entry] = [await entry(key), await entry((item as Record<string, unknown>)[key])], size = Buffer.byteLength(canonicalStringify(pair)) + 1;
          if (bytes + size > INLINE_BUDGET && items.length) { refs.push(await write({ codecVersion: 1, type: 'object-items', items })); items = []; bytes = 128; }
          items.push(pair); bytes += size;
        }
        if (items.length) refs.push(await write({ codecVersion: 1, type: 'object-items', items })); return branch('object', refs);
      } finally { active.delete(item); }
    };
    return encode(value);
  }
  async get(owner: WorkspaceOwner, root: CanonicalRef, context?: Pick<CanonicalWriteContext, 'deadline' | 'cancelled'>): Promise<JsonValue> {
    const active = new Set<string>();
    const decodeEntry = async (entry: Entry): Promise<JsonValue> => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 1) throw new Error('Invalid canonical entry.');
      if ('ref' in entry) return read(entry.ref); if ('value' in entry) { smallJson(entry.value, CANONICAL_BLOCK_MAX_BYTES); return entry.value; } throw new Error('Invalid canonical entry.');
    };
    const read = async (ref: CanonicalRef): Promise<JsonValue> => {
      check(context); if (!reference(ref)) throw new Error('Unsupported canonical codec reference.');
      if (active.has(ref.resourceId)) throw new Error('Cyclic canonical references.'); active.add(ref.resourceId);
      try {
        const bytes = await this.blocks.getCanonical(owner, ref);
        if (bytes.byteLength !== ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('Canonical integrity check failed.');
        const envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as Envelope;
        if (!envelope || envelope.codecVersion !== 1) throw new Error('Unsupported canonical codec version.');
        if (envelope.type === 'json') { smallJson(envelope.value, CANONICAL_BLOCK_MAX_BYTES); return envelope.value; }
        if (envelope.type === 'array-items') { const value: JsonValue[] = []; for (const item of envelope.items) value.push(await decodeEntry(item)); return value; }
        if (envelope.type === 'object-items') {
          const pairs: [string, JsonValue][] = [], names = new Set<string>();
          for (const [key, value] of envelope.items) { const name = await decodeEntry(key); if (typeof name !== 'string' || names.has(name)) throw new Error('Invalid canonical object key.'); names.add(name); pairs.push([name, await decodeEntry(value)]); }
          return Object.fromEntries(pairs);
        }
        if (!['array','object','string'].includes(envelope.type) || !('children' in envelope) || !Array.isArray(envelope.children) || envelope.children.length > FANOUT) throw new Error('Invalid canonical branch.');
        if (envelope.type === 'array') { const value: JsonValue[] = []; for (const ref of envelope.children) { const part = await read(ref); if (!Array.isArray(part)) throw new Error('Invalid canonical array.'); for (const child of part) value.push(child); } return value; }
        if (envelope.type === 'string') { const parts: string[] = []; for (const ref of envelope.children) { const part = await read(ref); if (typeof part !== 'string') throw new Error('Invalid canonical string.'); parts.push(part); } return parts.join(''); }
        const pairs: [string, JsonValue][] = [], names = new Set<string>();
        for (const ref of envelope.children) { const part = await read(ref); if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Invalid canonical object.'); for (const [name, child] of Object.entries(part)) { if (names.has(name)) throw new Error('Duplicate canonical object key.'); names.add(name); pairs.push([name, child]); } }
        return Object.fromEntries(pairs);
      } finally { active.delete(ref.resourceId); }
    };
    return read(root);
  }
}
