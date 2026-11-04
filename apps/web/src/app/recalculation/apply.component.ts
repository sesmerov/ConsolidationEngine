import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isRationalValue, isTerminalJob } from '@ce/contracts';
import type { ApplicationRequestDTO, PreviewDTO, PreviewSelectionDTO, ProposalDTO, Rational, SourceFile, SourceLocator } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
interface Attempt { workspaceId: string; etag: string; key: string; body: ApplicationRequestDTO }
@Component({ selector: 'ce-apply', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './apply.component.html' })
export class ApplyComponent {
  readonly preview = input.required<PreviewDTO>(); readonly selection = input<PreviewSelectionDTO | null>(null); readonly proposals = input<readonly ProposalDTO[]>([]); readonly sources = input<readonly SourceFile[]>([]);
  readonly session = inject(SessionStore); private readonly api = inject(ApiClient);
  readonly acknowledged = signal(false); readonly pending = signal(false); readonly error = signal<string | null>(null); readonly uncertain = signal(false); readonly rejected = signal(false);
  private attempt: Attempt | undefined; private workspaceId: string | undefined;
  readonly selectedProposals = computed(() => { const ids = new Set(this.selection()?.selectedIds ?? []); return this.proposals().filter(row => ids.has(row.id)); });
  readonly canApply = computed(() => {
    const preview = this.preview(), selection = this.selection(), rows = this.selectedProposals();
    return preview.state === 'ready' && preview.baseVersionId === this.session.versionId() && selection?.state === 'ready' && selection.complete && selection.requiredIds.length === 0 && selection.selectedIds.length > 0
      && rows.length === new Set(selection.selectedIds).size && rows.length === selection.selectedIds.length && rows.every(row => row.previewId === preview.id && row.state === 'available' && row.before && row.after)
      && !!this.session.etag() && !this.session.pending() && !this.session.jobActive() && !this.pending() && !this.uncertain() && !this.rejected();
  });
  constructor() {
    effect(() => { this.preview().id; this.selection(); this.proposals(); untracked(() => this.acknowledged.set(false)); });
    effect(() => { const id = this.session.workspace()?.id; if (id !== this.workspaceId) { this.workspaceId = id; untracked(() => { this.attempt = undefined; this.uncertain.set(false); this.pending.set(false); this.rejected.set(false); this.error.set(null); this.acknowledged.set(false); }); } });
  }
  async apply(): Promise<void> {
    const workspaceId = this.session.workspace()?.id, etag = this.session.etag(), selection = this.selection(); if (!workspaceId || !etag || !selection || !this.canApply() || !this.acknowledged()) return;
    this.attempt = { workspaceId, etag, key: crypto.randomUUID(), body: { baseVersionId: this.preview().baseVersionId, previewId: this.preview().id, selectedIds: [...selection.selectedIds], closureHash: selection.closureHash } };
    await this.send();
  }
  async retry(): Promise<void> { if (!this.uncertain() || this.pending() || this.session.pending() || this.session.jobActive()) return; await this.send(); }
  private async send(): Promise<void> {
    const attempt = this.attempt; if (!attempt || attempt.workspaceId !== this.session.workspace()?.id) return; this.pending.set(true); this.error.set(null);
    try { const job = await this.api.apply(attempt.workspaceId, attempt.body, attempt.etag, attempt.key); if (this.attempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return;
      this.uncertain.set(false); this.acknowledged.set(false); this.attempt = undefined; this.session.trackJob(job); if (isTerminalJob(job.status)) await this.session.refreshWorkspace(attempt.workspaceId);
    } catch (error) { if (this.attempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return;
      const uncertain = error instanceof HttpErrorResponse && (error.status === 0 || error.status >= 500); this.uncertain.set(uncertain); this.rejected.set(!uncertain);
      this.error.set(uncertain ? 'No se ha podido confirmar la respuesta. Reintenta la misma aplicación para recuperar su estado sin duplicar cambios.' : error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo aplicar la selección.');
    } finally { if (attempt.workspaceId === this.session.workspace()?.id) this.pending.set(false); }
  }
  target(row: ProposalDTO): string { const c = row.before?.coordinate; return c ? [c.contextId, c.tableCode, c.sheetCode ? 's' + c.sheetCode : '', 'r' + c.rowCode, 'c' + c.columnCode].filter(Boolean).join(' · ') : row.targetKey; }
  predecessor(id: string): string { const row = this.proposals().find(row => row.id === id); return row ? row.code + ' · ' + this.target(row) : id; }
  fraction(value: Rational): string { return value.denominator === '1' ? value.numerator : value.numerator + '/' + value.denominator; }
  source(locator: SourceLocator): string { return [this.sources().find(file => file.id === locator.fileId)?.displayName, locator.sheet, locator.column ? locator.column + (locator.row ?? '') : locator.row ? 'fila ' + locator.row : ''].filter(Boolean).join(' · '); }
  noChange(row: ProposalDTO): boolean {
    if (row.before?.presence !== 'value' || !row.after) return false; const a = row.before.normalizedValue, b = row.after.normalizedValue;
    return typeof a === 'boolean' || typeof b === 'boolean' ? a === b : isRationalValue(a) && a.numerator === b.numerator && a.denominator === b.denominator;
  }
}
