import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionStore } from '../core/session.store';
import { ImportStore } from './import.store';
import type { Diagnostic } from '@ce/contracts';
@Component({ selector: 'ce-import-page', standalone: true, imports: [FormsModule], providers: [ImportStore], templateUrl: './import-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class ImportPageComponent {
  readonly store = inject(ImportStore); readonly session = inject(SessionStore);
  readonly catalog = signal<File | null>(null); readonly reports = signal<readonly File[]>([]);
  readonly busy = computed(() => this.store.uploading() || this.session.jobActive() || this.session.pending());
  readonly catalogError = computed(() => { const file = this.catalog(); return file && !/\.xlsx$/i.test(file.name) ? 'El catálogo debe ser un archivo .xlsx.' : file && file.size > 10 * 1024 * 1024 ? 'El catálogo supera 10 MiB.' : null; });
  readonly reportsError = computed(() => this.reports().length > 20 ? 'Selecciona como máximo 20 informes.' : this.reports().some(file => !/\.xlsx$/i.test(file.name)) ? 'Todos los informes deben ser archivos .xlsx.' : this.reports().some(file => file.size > 10 * 1024 * 1024) ? 'Un informe supera 10 MiB.' : this.reports().reduce((sum, file) => sum + file.size, this.catalog()?.size ?? 0) > 50 * 1024 * 1024 ? 'El catálogo y los informes superan 50 MiB en total.' : null);
  readonly feedback = viewChild<ElementRef<HTMLElement>>('feedback');
  readonly catalogServerErrors = computed(() => this.fileErrors(this.catalog() ? [this.catalog()!.name] : []));
  readonly reportsServerErrors = computed(() => this.fileErrors(this.reports().map(file => file.name)));
  constructor() { effect(() => { const error = this.store.error(), feedback = this.feedback(); if (error && feedback) feedback.nativeElement.focus(); }); }
  chooseCatalog(event: Event): void { this.catalog.set((event.target as HTMLInputElement).files?.item(0) ?? null); }
  chooseReports(event: Event): void { this.reports.set(Array.from((event.target as HTMLInputElement).files ?? [])); }
  async upload(): Promise<void> { const catalog = this.catalog(); if (catalog && this.reports().length && !this.catalogError() && !this.reportsError()) await this.store.upload(catalog, this.reports()); }
  filter(): void { void this.store.load(); }
  private fileErrors(names: readonly string[]): readonly Diagnostic[] { const job = this.session.job(); return job?.kind === 'import' && job.status === 'failed' ? job.diagnostics.filter(error => !!error.fileName && names.includes(error.fileName)) : []; }
}
