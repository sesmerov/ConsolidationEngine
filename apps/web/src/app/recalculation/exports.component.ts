import { StageTitleDirective } from '../core/stage-title.directive';
import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { ExportStore } from './export.store';
import { civilDate } from '../core/display';
@Component({ selector: 'ce-exports', standalone: true, imports: [StageTitleDirective, DatePipe, MatButtonModule, MatFormFieldModule, MatInputModule, MatTableModule], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './exports.component.html' })
export class ExportsComponent { readonly store = inject(ExportStore);
readonly versionLabel = this.store.versionLabel;
readonly session = this.store.session;
readonly kind = this.store.kind;
readonly selectedRunId = this.store.selectedRunId;
readonly history = this.store.history;
readonly cursor = this.store.cursor;
readonly historyLoading = this.store.historyLoading;
readonly pending = this.store.pending;
readonly error = this.store.error;
readonly uncertain = this.store.uncertain;
readonly ready = this.store.ready;
readonly runs = this.store.runs;
readonly canStart = this.store.canStart;
readonly loadHistory = this.store.loadHistory.bind(this.store);
readonly start = this.store.start.bind(this.store);
readonly retry = this.store.retry.bind(this.store);
readonly download = this.store.download.bind(this.store);
readonly civilDate = civilDate;
readonly profiles = computed(() => [...new Set((this.store.summary()?.reports ?? []).map(report => this.profileLabel(report.profileId)))]);
readonly excludedCount = computed(() => this.store.summary()?.reports.reduce((total, report) => total + report.excludedSheets.length, 0) ?? 0);
readonly chosenRun = computed(() => this.runs().find(run => run.id === this.selectedRunId()));
readonly incompleteRun = computed(() => this.chosenRun()?.status === 'incomplete');
profileLabel(profile: string): string { return profile === 'eba-corep-of-4.0-ca1-v1' ? 'COREP de fondos propios · CA1' : profile === 'ce-demo-types-1' ? 'Demostración de texto y fechas' : profile === 'ce-report-1' ? 'Formato anterior' : 'Perfil no reconocido'; }
constructor() { effect(() => { this.session.workspace()?.id; this.session.exportVersionId(); untracked(() => { void this.store.loadSummary(); }); }); }
}
