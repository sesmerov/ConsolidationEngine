import { StageTitleDirective } from '../core/stage-title.directive';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTableModule } from '@angular/material/table';
import { SessionStore } from '../core/session.store';
import { ImportStore } from './import.store';
import { civilDate, versionLabel } from '../core/display';
import type { Diagnostic } from '@ce/contracts';
@Component({ selector: 'ce-import-page', standalone: true, imports: [StageTitleDirective, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatCheckboxModule, MatTableModule], templateUrl: './import-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`.context-form { min-width:0; border:1px solid #dce2ec; border-radius:10px; padding:20px; } .context-form legend { padding:0 8px; font-weight:600; } .context-form mat-form-field { min-width:0; width:100%; } .inspection-review { margin-top:24px; border-top:1px solid #dce2ec; padding-top:8px; } .excluded-sheets ul { columns:3 180px; padding-left:24px; } .demo-guide { min-width:0; margin:24px 0; padding:20px; border:1px solid #ccdcd9; border-radius:12px; background:#f5faf9; } .demo-guide h3 { margin-top:0; } .demo-guide mat-form-field { width:100%; max-width:460px; } .demo-guide ol { padding-left:24px; } .demo-guide li { margin-block:8px; } .demo-guide .data-table { min-width:460px; } .demo-guide .expected-change { white-space:nowrap; font-variant-numeric:tabular-nums; }`] })
export class ImportPageComponent {
  readonly store = inject(ImportStore); readonly session = inject(SessionStore);
  readonly technicalHelpOpen = signal(false);
  private readonly helpTrigger = viewChild('helpTrigger', { read: ElementRef<HTMLButtonElement> });
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  readonly catalog = this.store.catalog; readonly reports = this.store.reports;
  readonly civilDate = civilDate; readonly versionLabel = versionLabel;
  // These are instructions for the distributed example, never inputs to the evaluator or configured directions.
  readonly demoChanges = [
    { code: 'v0174_m', row: '0070', before: '5,00', after: '60,00' },
    { code: 'v0173_m', row: '0030', before: '100,00', after: '185,00' },
    { code: 'v0176_m', row: '0150', before: '10,00', after: '50,00' },
    { code: 'v0175_m', row: '0130', before: '20,00', after: '100,00' },
    { code: 'v0172_m', row: '0020', before: '1.000,00', after: '285,00' },
  ];
  filingIndicators(indicators: Readonly<Record<string, boolean>>): readonly { code: string; presented: boolean }[] { return Object.entries(indicators).map(([code, presented]) => ({ code, presented })); }
  profileLabel(profile: string): string { return profile === 'eba-corep-of-4.0-ca1-v1' ? 'COREP de fondos propios · CA1' : profile === 'ce-demo-types-1' ? 'Demostración de texto y fechas' : profile === 'ce-report-1' ? 'Formato anterior' : 'Perfil reconocido por el servidor'; }
  readonly busy = computed(() => this.store.uploading() || this.store.inspectionPending() || this.store.uncertainCommit() || this.session.jobActive() || this.session.pending());
  readonly catalogError = computed(() => { const file = this.catalog(); return file && !/\.xlsx$/i.test(file.name) ? 'El catálogo debe ser un archivo .xlsx.' : file && file.size > 10 * 1024 * 1024 ? 'El catálogo supera 10 MiB.' : null; });
  readonly reportsError = computed(() => this.reports().length > 20 ? 'Selecciona como máximo 20 informes.' : this.reports().some(file => !/\.xlsx$/i.test(file.name)) ? 'Todos los informes deben ser archivos .xlsx.' : this.reports().some(file => file.size > 10 * 1024 * 1024) ? 'Un informe supera 10 MiB.' : this.reports().reduce((sum, file) => sum + file.size, this.catalog()?.size ?? 0) > 50 * 1024 * 1024 ? 'El catálogo y los informes superan 50 MiB en total.' : null);
  readonly feedback = viewChild<ElementRef<HTMLElement>>('feedback');
  readonly catalogServerErrors = computed(() => this.fileErrors(this.catalog() ? [this.catalog()!.name] : []));
  readonly reportsServerErrors = computed(() => this.fileErrors(this.reports().map(file => file.name)));
  constructor() { effect(() => { const error = this.store.error(), feedback = this.feedback(); if (error && feedback) feedback.nativeElement.focus(); }); }
  chooseCatalog(event: Event): void { this.catalog.set((event.target as HTMLInputElement).files?.item(0) ?? null); }
  chooseReports(event: Event): void { this.reports.set(Array.from((event.target as HTMLInputElement).files ?? [])); }
  async upload(): Promise<void> {
    if (!this.catalogError() && !this.reportsError()) await this.store.inspect();
  }
  closeHelp(): void {
    if (!this.technicalHelpOpen()) return;
    this.technicalHelpOpen.set(false);
    (this.helpTrigger()?.nativeElement ?? this.heading()?.nativeElement)?.focus();
  }
  private fileErrors(names: readonly string[]): readonly Diagnostic[] { const job = this.session.job(); return (job?.kind === 'import' || job?.kind === 'inspect-import') && job.status === 'failed' ? job.diagnostics.filter(error => !!error.fileName && names.includes(error.fileName)) : []; }
}
