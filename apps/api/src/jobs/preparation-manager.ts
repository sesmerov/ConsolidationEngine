import type { WorkspaceStore } from '../session/workspace-store.js';

/** Files allocated before job acceptance must finish cleanup before workspace removal. */
export class PreparationManager {
  private readonly pending = new Map<string, Set<Promise<void>>>();
  constructor(private readonly store: WorkspaceStore) {}
  acquire(workspaceId: string): () => void {
    this.store.assertAccepting(workspaceId);
    let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
    const operations = this.pending.get(workspaceId) ?? new Set<Promise<void>>();
    this.pending.set(workspaceId, operations); operations.add(done); let released = false;
    return () => {
      if (released) return; released = true; operations.delete(done); finish();
      if (!operations.size) this.pending.delete(workspaceId);
    };
  }
  async settle(workspaceId: string): Promise<void> { await Promise.all(this.pending.get(workspaceId) ?? []); }
}
