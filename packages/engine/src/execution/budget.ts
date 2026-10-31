/** Shared counters for a complete job, including repeated reads across expressions. */
export interface WorkLimits { readonly instances: number; readonly edges: number; readonly reads: number; readonly milliseconds: number }
export const WORK_LIMITS: WorkLimits = Object.freeze({ instances: 1_000_000, edges: 1_000_000, reads: 10_000_000, milliseconds: 60_000 });
export class WorkLimitError extends Error {
  constructor(readonly code: 'RESOURCE_LIMIT' | 'CANCELLED' | 'DEADLINE_EXCEEDED', message: string) { super(message); }
}
export class WorkBudget {
  readonly limits: WorkLimits;
  readonly counts = { instances: 0, edges: 0, reads: 0 };
  private readonly started: number;
  constructor(private readonly options: { limits?: Partial<WorkLimits>; cancelled?: () => boolean; now?: () => number } = {}) {
    this.limits = { ...WORK_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 0 || value > WORK_LIMITS[key as keyof WorkLimits]) throw new WorkLimitError('RESOURCE_LIMIT', 'Invalid work limit');
    this.started = this.now();
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  check(): void {
    if (this.options.cancelled?.()) throw new WorkLimitError('CANCELLED', 'Validation cancelled');
    if (this.now() - this.started >= this.limits.milliseconds) throw new WorkLimitError('DEADLINE_EXCEEDED', 'Validation deadline exceeded');
  }
  consume(kind: 'instances' | 'edges' | 'reads', count = 1): void {
    this.check();
    if (!Number.isSafeInteger(count) || count < 0 || this.counts[kind] + count > this.limits[kind]) throw new WorkLimitError('RESOURCE_LIMIT', `${kind} work limit exceeded`);
    this.counts[kind] += count;
  }
}
