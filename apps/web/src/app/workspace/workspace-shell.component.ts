import { afterEveryRender, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import type { DoCheck } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatPaginatorIntl } from '@angular/material/paginator';
import type { JobStatus } from '@ce/contracts';
import { SessionStore } from '../core/session.store';
import { StageFocus } from '../core/stage-title.directive';
import { civilDate, versionLabel } from '../core/display';
import { spanishPaginator } from '../core/cursor-page';
import { ImportStore } from '../import/import.store';
import { ImportPageComponent } from '../import/import-page.component';
import { ResultsStore } from '../validation/results.store';
import { ValidationPageComponent } from '../validation/validation-page.component';
import { PreviewStore } from '../recalculation/preview.store';
import { PreviewPageComponent } from '../recalculation/preview-page.component';
import { DirectionsStore } from '../recalculation/directions.store';
import { ApplyStore } from '../recalculation/apply.store';
import { ExportStore } from '../recalculation/export.store';
import { ExportsComponent } from '../recalculation/exports.component';
import { WorkspaceViewStore } from './workspace-view.store';
import type { WorkspaceStage } from './workspace-view.store';
@Component({ selector: 'ce-workspace-shell', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, ImportPageComponent, ValidationPageComponent, PreviewPageComponent, ExportsComponent],
providers: [WorkspaceViewStore, StageFocus, ImportStore, ResultsStore, PreviewStore, DirectionsStore, ApplyStore, ExportStore, { provide: MatPaginatorIntl, useFactory: spanishPaginator }], templateUrl: './workspace-shell.component.html', styleUrl: './workspace-shell.component.scss' })
export class WorkspaceShellComponent implements DoCheck {
readonly session = inject(SessionStore); readonly view = inject(WorkspaceViewStore); readonly confirmClose = signal(false);
private readonly imports = inject(ImportStore); private readonly results = inject(ResultsStore); private readonly proposals = inject(PreviewStore);
private readonly directions = inject(DirectionsStore);
private readonly exports = inject(ExportStore);
readonly visibleJob = computed(() => { const job = this.session.job(); return job && !this.view.resultWasPresented(job) ? job : null; });
readonly stages = [
  { id: 'import', label: '1. Cargar' }, { id: 'validation', label: '2. Validar' },
  { id: 'preview', label: '3. Recalcular' }, { id: 'exports', label: '4. Descargar' },
] as const;
readonly nextLabel = computed(() => this.stages.find(item => item.id === this.view.recommended())?.label.slice(3));
readonly announcement = signal('');
readonly pulse = signal<{ id: string; delay: number } | null>(null);
private pulseTimer?: ReturnType<typeof setTimeout>;
private readonly stageFocus = inject(StageFocus);
private readonly workspaceName = viewChild<ElementRef<HTMLElement>>('workspaceName');
private readonly contextSelector = viewChild('contextSelector', { read: ElementRef<HTMLSelectElement> });
readonly contextOptions = computed(() => {
  const contexts = this.session.workspace()?.contexts ?? [];
  const labelCounts = new Map<string, number>();
  const options = contexts.map(context => {
    const label = [context.entityId, civilDate(context.referenceDate), context.moduleVersion].join(' · ');
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    return { id: context.contextId, label };
  });
  return options.map((option, index) => labelCounts.get(option.label) === 1
    ? option
    : { id: option.id, label: option.label + ' · Contexto ' + (index + 1) });
});
readonly civilDate = civilDate; readonly versionLabel = versionLabel;
readonly stageArea = viewChild<ElementRef<HTMLElement>>('stageArea'); readonly closeTrigger = viewChild('closeTrigger', { read: ElementRef<HTMLButtonElement> }); readonly closeConfirm = viewChild('closeConfirm', { read: ElementRef<HTMLButtonElement> });
readonly jobFeedback = viewChild<ElementRef<HTMLElement>>('jobFeedback');
readonly jobStatus: Record<JobStatus, string> = { queued: 'Trabajo pendiente', running: 'Trabajo en curso', succeeded: 'Trabajo terminado', failed: 'No se pudo completar', cancelled: 'Trabajo cancelado', timed_out: 'Plazo de ejecución agotado' };
constructor() {
  afterEveryRender(() => {
    const resultPage = this.results.page(), artifact = this.exports.ready();
    const directionsRendered = resultPage?.run.id === this.results.selectedRunId() && resultPage?.run.id === this.directions.run()?.id;
    const resultsDownloadRendered = artifact?.kind === 'results' && artifact.runId === resultPage?.run.id && artifact.versionId === resultPage?.run.versionId;
    const result = this.view.stage() === 'import' ? this.imports.resultPresentation()
      : this.view.stage() === 'validation' ? this.results.resultPresentation() ?? (directionsRendered ? this.directions.resultPresentation() : null) ?? (resultsDownloadRendered ? this.exports.resultPresentation() : null)
      : this.view.stage() === 'preview' ? this.proposals.resultPresentation()
      : this.exports.resultPresentation();
    if (result) this.view.resultPresented(result);
  });
  effect(() => {
    const highlight = this.view.highlight();
    untracked(() => {
      clearTimeout(this.pulseTimer);
      const elapsed = highlight ? Math.max(0, Date.now() - highlight.startedAt) : 4_500;
      this.pulse.set(highlight && elapsed < 4_500 ? { id: highlight.id, delay: -elapsed } : null);
      if (highlight && elapsed < 4_500) this.pulseTimer = setTimeout(() => this.pulse.set(null), 4_500 - elapsed);
      const label = this.view.claimAnnouncement();
      if (label) { this.announcement.set(''); queueMicrotask(() => this.announcement.set('Etapa recomendada: ' + label)); }
    });
  });
  inject(DestroyRef).onDestroy(() => clearTimeout(this.pulseTimer));
  effect(() => {
    const workspace = this.session.workspace();
    untracked(() => this.view.reconcile(workspace?.id ?? null, workspace?.currentVersionId ?? null));
  });
  effect(() => { if (this.confirmClose()) this.closeConfirm()?.nativeElement.focus(); });
  effect(() => { const job = this.session.job(), feedback = this.jobFeedback(); if (feedback && (job?.status === 'failed' || job?.status === 'timed_out')) feedback.nativeElement.focus(); });
}
ngDoCheck(): void {
  const workspace = this.session.workspace();
  if (!workspace || workspace.contexts.length > 1) return;
  // Return focus before Angular removes a context selector the analyst was using.
  const select = this.contextSelector()?.nativeElement;
  if (select && select.ownerDocument.activeElement === select) this.workspaceName()?.nativeElement.focus();
}
navigate(stage: WorkspaceStage): void { if (stage !== this.view.stage() && !this.directions.allowLeaveEditor()) return; this.stageFocus.request({ import: 'import-title', validation: 'validation-title', preview: 'preview-title', exports: 'exports-title' }[stage]); this.view.visit(stage); }
cancelClose(): void { this.confirmClose.set(false); this.closeTrigger()?.nativeElement.focus(); }
async close(): Promise<void> { await this.session.close(); }
}
