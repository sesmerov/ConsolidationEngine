import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
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
export class WorkspaceShellComponent {
readonly session = inject(SessionStore); readonly view = inject(WorkspaceViewStore); readonly confirmClose = signal(false);
private readonly stageFocus = inject(StageFocus);
readonly civilDate = civilDate; readonly versionLabel = versionLabel;
readonly stageArea = viewChild<ElementRef<HTMLElement>>('stageArea'); readonly closeTrigger = viewChild('closeTrigger', { read: ElementRef<HTMLButtonElement> }); readonly closeConfirm = viewChild('closeConfirm', { read: ElementRef<HTMLButtonElement> });
readonly jobFeedback = viewChild<ElementRef<HTMLElement>>('jobFeedback');
readonly jobStatus: Record<JobStatus, string> = { queued: 'Trabajo pendiente', running: 'Trabajo en curso', succeeded: 'Trabajo terminado', failed: 'No se pudo completar', cancelled: 'Trabajo cancelado', timed_out: 'Plazo de ejecución agotado' };
constructor() { effect(() => { if (this.confirmClose()) this.closeConfirm()?.nativeElement.focus(); }); effect(() => { const job = this.session.job(), feedback = this.jobFeedback(); if (feedback && (job?.status === 'failed' || job?.status === 'timed_out')) feedback.nativeElement.focus(); }); }
navigate(stage: WorkspaceStage): void { this.stageFocus.request({ import: 'import-title', validation: 'validation-title', preview: 'preview-title', exports: 'exports-title' }[stage]); this.view.stage.set(stage); }
cancelClose(): void { this.confirmClose.set(false); this.closeTrigger()?.nativeElement.focus(); }
async close(): Promise<void> { await this.session.close(); }
}
