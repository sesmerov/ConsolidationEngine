import { createHash } from 'node:crypto';

function primitive(value: unknown): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'object' && value !== null) return undefined;
  throw new TypeError('Only finite JSON data can enter session state.');
}
function keys(value: object): string[] {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Session objects must be plain JSON.');
  return Object.keys(value).sort();
}
export function canonicalStringify(value: unknown): string {
  const ancestors = new WeakSet<object>();
  function encode(item: unknown): string {
    const scalar = primitive(item); if (scalar !== undefined) return scalar;
    const object = item as object;
    if (ancestors.has(object)) throw new TypeError('Cyclic session data.');
    ancestors.add(object);
    const result = Array.isArray(item) ? '[' + item.map(encode).join(',') + ']'
      : '{' + keys(object).map((key) => JSON.stringify(key) + ':' + encode((item as Record<string, unknown>)[key])).join(',') + '}';
    ancestors.delete(object); return result;
  }
  return encode(value);
}
export function canonicalHash(value: unknown): string { return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex'); }
/** Count canonical JSON syntax and primitives, visiting a shared object/array only once across all retained roots. */
export function canonicalStateBytes(roots: readonly unknown[]): number {
  const seen = new WeakSet<object>(); const ancestors = new WeakSet<object>();
  function count(item: unknown): number {
    const scalar = primitive(item); if (scalar !== undefined) return Buffer.byteLength(scalar, 'utf8');
    const object = item as object;
    if (ancestors.has(object)) throw new TypeError('Cyclic session data.');
    if (seen.has(object)) return 0;
    seen.add(object); ancestors.add(object);
    let size = 2;
    if (Array.isArray(item)) size += Math.max(0, item.length - 1) + item.reduce((sum: number, child: unknown) => sum + count(child), 0);
    else {
      const names = keys(object); size += Math.max(0, names.length - 1);
      for (const key of names) size += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + count((item as Record<string, unknown>)[key]);
    }
    ancestors.delete(object); return size;
  }
  return roots.reduce<number>((sum, value) => sum + count(value), 0);
}
/** Take ownership of mutable inputs; immutable branches are shared by subsequent snapshots. */
export function immutable<T>(value: T): T {
  canonicalStringify(value);
  function copy(item: unknown): unknown {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) {
      const children = item.map(copy);
      return Object.isFrozen(item) && children.every((child, i) => child === item[i]) ? item : Object.freeze(children);
    }
    const entries = Object.entries(item).map(([key, child]) => [key, copy(child)] as const);
    return Object.isFrozen(item) && entries.every(([key, child]) => child === (item as Record<string, unknown>)[key])
      ? item : Object.freeze(Object.fromEntries(entries));
  }
  return copy(value) as T;
}
