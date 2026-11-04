import { StageTitleDirective } from '../core/stage-title.directive';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { SessionStore } from '../core/session.store';
import { ImportStore } from './import.store';
import { civilDate, versionLabel } from '../core/display';
import type { Diagnostic } from '@ce/contracts';
@Component({ selector: 'ce-import-page', standalone: true, imports: [StageTitleDirective, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatCheckboxModule], templateUrl: './import-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`.context-form { min-width:0; border:1px solid #dce2ec; border-radius:10px; padding:20px; } .context-form legend { padding:0 8px; font-weight:600; } .context-form mat-form-field { min-width:0; width:100%; } .inspection-review { margin-top:24px; border-top:1px solid #dce2ec; padding-top:8px; } .excluded-sheets ul { columns:3 180px; padding-left:24px; }`] })
export class ImportPageComponent {
  readonly store = inject(ImportStore); readonly session = inject(SessionStore);
  readonly catalog = this.store.catalog; readonly reports = this.store.reports;
  readonly civilDate = civilDate; readonly versionLabel = versionLabel;
  readonly busy = computed(() => this.store.uploading() || this.store.inspectionPending() || this.store.uncertainCommit() || this.session.jobActive() || this.session.pending());
  readonly catalogError = computed(() => { const file = this.catalog(); return file && !/\.xlsx$/i.test(file.name) ? 'El catálogo debe ser un archivo .xlsx.' : file && file.size > 10 * 1024 * 1024 ? 'El catálogo supera 10 MiB.' : null; });
  readonly reportsError = computed(() => this.reports().length > 20 ? 'Selecciona como máximo 20 informes.' : this.reports().some(file => !/\.xlsx$/i.test(file.name)) ? 'Todos los informes deben ser archivos .xlsx.' : this.reports().some(file => file.size > 10 * 1024 * 1024) ? 'Un informe supera 10 MiB.' : this.reports().reduce((sum, file) => sum + file.size, this.catalog()?.size ?? 0) > 50 * 1024 * 1024 ? 'El catálogo y los informes superan 50 MiB en total.' : null);
  readonly feedback = viewChild<ElementRef<HTMLElement>>('feedback');
  readonly catalogServerErrors = computed(() => this.fileErrors(this.catalog() ? [this.catalog()!.name] : []));
  readonly reportsServerErrors = computed(() => this.fileErrors(this.reports().map(file => file.name)));
  constructor() { effect(() => { const error = this.store.error(), feedback = this.feedback(); if (error && feedback) feedback.nativeElement.focus(); }); }
  chooseCatalog(event: Event): void { this.catalog.set((event.target as HTMLInputElement).files?.item(0) ?? null); }
  chooseReports(event: Event): void { this.reports.set(Array.from((event.target as HTMLInputElement).files ?? [])); }
  async upload(): Promise<void> { const catalog = this.catalog(); if (catalog && this.reports().length && !this.catalogError() && !this.reportsError()) { if (this.store.legacy()) await this.store.upload(catalog, this.reports()); else await this.store.inspect(); } }
  filter(): void { void this.store.load(); }
  private fileErrors(names: readonly string[]): readonly Diagnostic[] { const job = this.session.job(); return (job?.kind === 'import' || job?.kind === 'inspect-import') && job.status === 'failed' ? job.diagnostics.filter(error => !!error.fileName && names.includes(error.fileName)) : []; }
}
