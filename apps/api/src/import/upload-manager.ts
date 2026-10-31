import { ApiError } from '../errors.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
interface Reception { readonly controller: AbortController; readonly done: Promise<void>; readonly release: () => void }
/** One bounded reception per workspace, including idempotent replay bodies. */
export class UploadManager {
  private readonly receptions = new Map<string, Reception>();
  constructor(private readonly store: WorkspaceStore) {}
  acquire(workspaceId: string): { signal: AbortSignal; release: () => void } {
    this.store.assertAccepting(workspaceId);
    if (this.receptions.has(workspaceId)) throw new ApiError('WORKSPACE_BUSY');
    const controller = new AbortController(); let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
    const reception: Reception = { controller, done, release: () => { if (this.receptions.get(workspaceId) === reception) this.receptions.delete(workspaceId); finish(); } };
    this.receptions.set(workspaceId, reception); return { signal: controller.signal, release: reception.release };
  }
  async cancel(workspaceId: string): Promise<void> { const reception = this.receptions.get(workspaceId); if (reception) { reception.controller.abort(); await reception.done; } }
  async dispose(): Promise<void> { await Promise.all([...this.receptions.keys()].map((id) => this.cancel(id))); }
}
