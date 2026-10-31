import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { JobStatus } from '@ce/contracts';
import { SessionStore } from './core/session.store';
import { ImportPageComponent } from './import/import-page.component';
import { ValidationPageComponent } from './validation/validation-page.component';
import { PreviewPageComponent } from './recalculation/preview-page.component';
import { ExportsComponent } from './recalculation/exports.component';
import { civilDate, versionLabel } from './core/display';

@Component({
  selector: 'ce-root',
  standalone: true,
  imports: [FormsModule, ImportPageComponent, ValidationPageComponent, PreviewPageComponent, ExportsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main-content">Saltar al contenido principal</a><div class="shell">
      <aside><span class="brand-mark">CE</span><strong>ConsolidationEngine</strong><p>Informes regulatorios</p></aside>
      <main id="main-content" tabindex="-1">
        <header><p class="eyebrow">ESPACIO DE TRABAJO LOCAL</p><h1>Validación de informes</h1></header>
        <p class="session-notice">Sesión temporal: los datos se conservan mientras este servidor esté abierto. Al cerrar el conjunto o reiniciar el servidor se descartan.</p>
        @if (session.error(); as error) { <p class="error" role="alert">{{ error }}</p> }
        @if (!session.connected()) {
          <section class="empty-state"><h2>Conectar con la sesión local</h2><button (click)="session.connect()" [disabled]="session.pending()">{{ session.pending() ? 'Conectando…' : 'Conectar' }}</button></section>
        } @else if (session.workspace(); as workspace) {
          <section class="workspace-card" aria-labelledby="workspace-name">
            <div class="section-heading"><div><span class="status">{{ workspace.state === 'ready' ? 'Conjunto cargado' : 'Sin informes' }}</span><h2 id="workspace-name">{{ workspace.name }}</h2></div>
              <button #closeTrigger class="secondary" (click)="confirmClose.set(true)" [disabled]="session.pending()">Cerrar conjunto</button></div>
            @if (confirmClose()) { <div class="confirmation" role="group" aria-label="Confirmar cierre"><p>Cerrar descarta los datos temporales de este conjunto y cancela el trabajo en curso. Las descargas que ya hayas guardado en tu equipo permanecen.</p><button #closeConfirm class="danger" (click)="close()" [disabled]="session.pending()">Cerrar y descartar</button> <button class="secondary" (click)="cancelClose()">Volver</button></div> }
            @if (workspace.contexts.length) {
              <label for="context-selector">Contexto</label><select id="context-selector" [ngModel]="session.selectedContextId()" (ngModelChange)="session.selectContext($event)">@for (context of workspace.contexts; track context.contextId) { <option [value]="context.contextId">{{ context.entityId }} · {{ civilDate(context.referenceDate) }} · {{ context.moduleVersion }}</option> }</select>
            }
            <dl class="workspace-meta"><div><dt>Versión</dt><dd>{{ versionLabel(workspace, session.versionId()) }}</dd></div>@if (session.selectedContext(); as context) { <div><dt>Entidad</dt><dd>{{ context.entityId }}</dd></div><div><dt>Periodo de referencia</dt><dd>{{ civilDate(context.referenceDate) }}</dd></div> }<div><dt>Informes y catálogo</dt><dd>{{ workspace.counts.sources }} archivos</dd></div></dl>
            <details class="trace-details"><summary>Identificador de la versión</summary><p data-testid="current-version-id">{{ session.versionId() ?? 'Pendiente de la primera carga' }}</p></details>
          </section>
          <nav class="stage-nav" aria-label="Etapas del trabajo"><a href="#import-title">1. Cargar</a>@if (workspace.currentVersionId) { <a href="#validation-title">2. Validar y configurar</a><a href="#preview-title">3. Revisar y aplicar</a><a href="#exports-title">4. Guardar</a> }</nav>
          @if (session.job(); as job) {
            <section class="workspace-card" aria-live="polite"><div class="section-heading"><h2>{{ jobStatus[job.status] }}</h2>@if (session.jobActive()) { <button class="secondary" (click)="session.cancelJob()" [disabled]="session.pending()">Cancelar trabajo</button> }</div>
              @if (job.progress.total > 0) { <progress aria-label="Progreso del trabajo" [value]="job.progress.completed" [max]="job.progress.total"></progress><p>{{ job.progress.completed }} de {{ job.progress.total }}</p> }
              @if (!job.progress.complete) { <p class="muted">Progreso incompleto. No representa un resultado final de validación.</p> }
              @if (job.kind === 'apply' && job.status === 'succeeded') { <p>Aplicación completada. La versión ya está publicada; una petición de cancelación posterior no revierte sus cambios.</p> }
              @if (job.kind === 'apply' && (job.status === 'cancelled' || job.status === 'failed' || job.status === 'timed_out')) { <p>No se publicó una versión para esta aplicación.</p> }
              @for (diagnostic of job.diagnostics; track $index) { <p #jobFeedback class="error" role="alert" tabindex="-1">{{ diagnostic.message }} @if (diagnostic.fileName) { · {{ diagnostic.fileName }} } @if (diagnostic.locator?.sheet) { · {{ diagnostic.locator.sheet }} } @if (diagnostic.locator?.column) { · {{ diagnostic.locator.column }}{{ diagnostic.locator.row }} }</p> }
            </section>
          }
          <ce-import-page/>
          @if (workspace.currentVersionId) { <ce-validation-page/><ce-preview-page/><ce-exports/> }
        } @else {
          <section class="empty-state"><span class="status">Nueva sesión</span><h2>Crea un conjunto de informes</h2><p>Asigna un nombre para identificar el trabajo de esta sesión.</p>
            <form (ngSubmit)="session.create(name)"><label for="workspace-name-input">Nombre del conjunto</label><input id="workspace-name-input" name="name" [(ngModel)]="name" maxlength="100" required placeholder="Ej. Cierre trimestral"/><button type="submit" [disabled]="session.pending() || !name.trim()">Crear conjunto</button></form>
          </section>
        }
      </main>
    </div>
  `,
})
export class AppComponent {
  readonly session = inject(SessionStore);
  readonly confirmClose = signal(false);
  readonly civilDate = civilDate; readonly versionLabel = versionLabel;
  readonly closeConfirm = viewChild<ElementRef<HTMLButtonElement>>('closeConfirm'); readonly closeTrigger = viewChild<ElementRef<HTMLButtonElement>>('closeTrigger');
  readonly jobFeedback = viewChild<ElementRef<HTMLElement>>('jobFeedback');
  name = '';
  readonly jobStatus: Record<JobStatus, string> = { queued: 'Trabajo pendiente', running: 'Trabajo en curso', succeeded: 'Trabajo terminado', failed: 'No se pudo completar', cancelled: 'Trabajo cancelado', timed_out: 'Plazo de ejecución agotado' };
  constructor() { void this.session.connect(); effect(() => { const button = this.closeConfirm(); if (this.confirmClose() && button) button.nativeElement.focus(); }); effect(() => { const job = this.session.job(), feedback = this.jobFeedback(); if (feedback && (job?.status === 'failed' || job?.status === 'timed_out')) feedback.nativeElement.focus(); }); }
  cancelClose(): void { this.confirmClose.set(false); this.closeTrigger()?.nativeElement.focus(); }
  async close(): Promise<void> { await this.session.close(); if (!this.session.workspace()) this.confirmClose.set(false); }
}
