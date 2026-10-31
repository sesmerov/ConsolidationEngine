/** Incremental canonicalStateBytes for already validated, immutable JSON graphs. */
export class RetainedSize {
  private references = new Map<object, number>();
  private roots = new Map<object, number>();
  private primitiveRoots = 0;
  private total = 0;
  private generation = 0;
  get bytes(): number { return this.total; }
  prepare(roots: readonly unknown[]): { readonly bytes: number; commit(): void } {
    const generation = this.generation, nextRoots = new Map<object, number>(); let primitiveRoots = 0;
    for (const value of roots) {
      if (value !== null && typeof value === 'object') nextRoots.set(value, (nextRoots.get(value) ?? 0) + 1);
      else primitiveRoots += scalarBytes(value);
    }
    const changes = new Map<object, number>(); let bytes = this.total + primitiveRoots - this.primitiveRoots;
    const adjust = (root: object, amount: number): void => {
      const pending: [object, number][] = [[root, amount]];
      while (pending.length) {
        const [object, delta] = pending.pop()!;
        const before = changes.get(object) ?? this.references.get(object) ?? 0, after = before + delta;
        if (after < 0) throw new Error('Invalid retained reference count');
        changes.set(object, after);
        if ((before === 0) === (after === 0)) continue;
        const sign = after === 0 ? -1 : 1;
        const array = Array.isArray(object), names = array ? undefined : Object.keys(object);
        if (!array && Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) throw new TypeError('Session objects must be plain JSON.');
        const length = array ? object.length : names!.length;
        let ownBytes = 2 + Math.max(0, length - 1);
        for (let index = 0; index < length; index++) {
          if (array && !Object.hasOwn(object, index)) continue;
          const key = array ? index : names![index]!;
          if (!array) ownBytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
          const child = (object as Record<string | number, unknown>)[key];
          if (child !== null && typeof child === 'object') pending.push([child, sign]);
          else ownBytes += scalarBytes(child);
        }
        bytes += sign * ownBytes;
      }
    };
    // Add first: shared descendants never become unreachable during root replacement.
    for (const [root, count] of nextRoots) { const delta = count - (this.roots.get(root) ?? 0); if (delta > 0) adjust(root, delta); }
    for (const [root, count] of this.roots) { const delta = (nextRoots.get(root) ?? 0) - count; if (delta < 0) adjust(root, delta); }
    return { bytes, commit: () => {
      if (generation !== this.generation) throw new Error('Stale retained-size transaction');
      for (const [object, count] of changes) { if (count === 0) this.references.delete(object); else this.references.set(object, count); }
      this.roots = nextRoots; this.primitiveRoots = primitiveRoots; this.total = bytes; this.generation++;
    } };
  }
}
function scalarBytes(value: unknown): number {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return Buffer.byteLength(JSON.stringify(value), 'utf8');
  throw new TypeError('Only finite JSON data can enter retained state.');
}
