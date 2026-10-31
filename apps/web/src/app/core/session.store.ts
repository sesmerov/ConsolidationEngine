import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { HttpResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { JobDTO, WorkspaceDTO } from '@ce/contracts';
import { ApiClient } from './api-client';
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(ApiClient);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  readonly connected = signal(false);
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  readonly workspace = signal<WorkspaceDTO | null>(null);
  readonly etag = signal<string | null>(null);
  readonly job = signal<JobDTO | null>(null);
  readonly selectedContextId = signal<string | null>(null);
  readonly selectedExportVersionId = signal<string | null>(null);
  readonly versionId = computed(() => this.workspace()?.currentVersionId ?? null);
  readonly exportVersionId = computed(() => { const selected = this.selectedExportVersionId(); return selected && this.workspace()?.versionIds.includes(selected) ? selected : this.versionId(); });
  readonly selectedContext = computed(() => this.workspace()?.contexts.find((context) => context.contextId === this.selectedContextId()) ?? null);
  readonly jobActive = computed(() => { const job = this.job(); return job ? !isTerminalJob(job.status) : false; });
  constructor() { inject(DestroyRef).onDestroy(() => this.stopPolling()); }
  async connect(): Promise<void> {
    this.stopPolling();
    await this.perform(async () => {
      const bootstrap = await this.api.bootstrap(); this.api.setSessionToken(bootstrap.sessionToken); this.connected.set(true);
      if (bootstrap.activeWorkspaceId) await this.refreshWorkspace(bootstrap.activeWorkspaceId);
      else { this.workspace.set(null); this.etag.set(null); this.job.set(null); this.selectedContextId.set(null); this.selectedExportVersionId.set(null); }
    });
  }
  async create(name: string): Promise<void> { await this.perform(async () => { this.acceptWorkspace(await this.api.createWorkspace(name)); }); }
  async close(): Promise<void> {
    const workspace = this.workspace(); const etag = this.etag(); if (!workspace || !etag) return;
    await this.perform(async () => {
      await this.api.closeWorkspace(workspace.id, etag); this.stopPolling(); this.workspace.set(null); this.etag.set(null); this.job.set(null); this.selectedContextId.set(null); this.selectedExportVersionId.set(null);
    });
  }
  async refreshWorkspace(id = this.workspace()?.id): Promise<void> {
    if (!id) return;
    const generation = this.generation;
    const response = await this.api.workspace(id); if (generation !== this.generation) return; this.acceptWorkspace(response);
    const active = response.body?.activeJobId;
    if (active) { const job = await this.api.job(id, active); if (generation === this.generation) this.trackJob(job); }
  }
  selectContext(id: string): void {
    if (this.workspace()?.contexts.some((context) => context.contextId === id)) this.selectedContextId.set(id);
  }
  selectExportVersion(id: string): void { if (this.workspace()?.versionIds.includes(id)) this.selectedExportVersionId.set(id); }
  trackJob(job: JobDTO): void {
    this.stopPolling(); this.job.set(job);
    if (!isTerminalJob(job.status)) this.schedule(this.generation);
  }
  async cancelJob(): Promise<void> {
    const job = this.job(); if (!job) return;
    await this.perform(async () => { const result = await this.api.cancelJob(job.workspaceId, job.jobId); this.trackJob(result); await this.refreshWorkspace(job.workspaceId); });
  }
  private acceptWorkspace(response: HttpResponse<WorkspaceDTO>): void {
    if (!response.body || !response.headers.get('ETag')) throw new Error('Invalid workspace response');
    if (this.workspace()?.id !== response.body.id || this.selectedExportVersionId() && !response.body.versionIds.includes(this.selectedExportVersionId()!)) this.selectedExportVersionId.set(null);
    this.workspace.set(response.body); this.etag.set(response.headers.get('ETag'));
    if (!response.body.contexts.some((context) => context.contextId === this.selectedContextId())) this.selectedContextId.set(response.body.contexts[0]?.contextId ?? null);
  }
  private schedule(generation: number): void {
    this.timer = setTimeout(() => { void this.poll(generation); }, Math.max(250, this.job()?.pollAfterMs ?? 1000));
  }
  private async poll(generation: number): Promise<void> {
    const job = this.job(); if (!job || generation !== this.generation) return;
    try {
      const current = await this.api.job(job.workspaceId, job.jobId);
      if (generation !== this.generation) return;
      this.job.set(current);
      if (isTerminalJob(current.status)) await this.refreshWorkspace(job.workspaceId); else this.schedule(generation);
    } catch (error) { if (generation === this.generation) { this.stopPolling(); this.report(error); } }
  }
  private stopPolling(): void { this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async perform(action: () => Promise<void>): Promise<void> {
    this.pending.set(true); this.error.set(null);
    try { await action(); } catch (error) { this.report(error); } finally { this.pending.set(false); }
  }
  private report(error: unknown): void {
    if (error instanceof HttpErrorResponse && error.status === 403) { this.connected.set(false); this.api.clearSession(); this.stopPolling(); }
    const message = error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo conectar con la sesión local. Comprueba que el servidor siga abierto.';
    this.error.set(message);
  }
}
