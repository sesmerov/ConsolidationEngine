import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionStore } from '../core/session.store';
import { ImportStore } from './import.store';
@Component({ selector: 'ce-import-page', standalone: true, imports: [FormsModule], providers: [ImportStore], templateUrl: './import-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class ImportPageComponent {
  readonly store = inject(ImportStore); readonly session = inject(SessionStore);
  readonly catalog = signal<File | null>(null); readonly reports = signal<readonly File[]>([]);
  readonly busy = computed(() => this.store.uploading() || this.session.jobActive() || this.session.pending());
  chooseCatalog(event: Event): void { this.catalog.set((event.target as HTMLInputElement).files?.item(0) ?? null); }
  chooseReports(event: Event): void { this.reports.set(Array.from((event.target as HTMLInputElement).files ?? [])); }
  async upload(): Promise<void> { const catalog = this.catalog(); if (catalog && this.reports().length) await this.store.upload(catalog, this.reports()); }
  filter(): void { void this.store.load(); }
}
