import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { JobStatus } from '@ce/contracts';
import { SessionStore } from './core/session.store';

@Component({
  selector: 'ce-root',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <aside><span class="brand-mark">CE</span><strong>ConsolidationEngine</strong><p>Informes regulatorios</p></aside>
      <main>
        <header><p class="eyebrow">ESPACIO DE TRABAJO LOCAL</p><h1>Validación de informes</h1></header>
        <p class="session-notice">Sesión temporal: los datos se conservan mientras este servidor esté abierto. Al cerrar el conjunto o reiniciar el servidor se descartan.</p>
        @if (session.error(); as error) { <p class="error" role="alert">{{ error }}</p> }
        @if (!session.connected()) {
          <section class="empty-state"><h2>Conectar con la sesión local</h2><button (click)="session.connect()" [disabled]="session.pending()">{{ session.pending() ? 'Conectando…' : 'Conectar' }}</button></section>
        } @else if (session.workspace(); as workspace) {
          <section class="workspace-card" aria-labelledby="workspace-name">
            <div class="section-heading"><div><span class="status">{{ workspace.state === 'ready' ? 'Conjunto cargado' : 'Sin informes' }}</span><h2 id="workspace-name">{{ workspace.name }}</h2></div>
              <button class="secondary" (click)="confirmClose.set(true)" [disabled]="session.pending()">Cerrar conjunto</button></div>
            @if (confirmClose()) { <div class="confirmation"><p>Cerrar descarta los datos de este conjunto y cancela el trabajo en curso.</p><button class="danger" (click)="close()" [disabled]="session.pending()">Cerrar y descartar</button> <button class="secondary" (click)="confirmClose.set(false)">Volver</button></div> }
            @if (workspace.contexts.length) {
              <label>Contexto <select [ngModel]="session.selectedContextId()" (ngModelChange)="session.selectContext($event)">@for (context of workspace.contexts; track context.contextId) { <option [value]="context.contextId">{{ context.entityId }} · {{ context.referenceDate }} · {{ context.moduleVersion }}</option> }</select></label>
            }
            <dl class="workspace-meta"><div><dt>Versión</dt><dd>{{ session.versionId() ?? 'Pendiente de la primera carga' }}</dd></div><div><dt>Informes y catálogo</dt><dd>{{ workspace.counts.sources }} archivos</dd></div></dl>
            @if (!workspace.currentVersionId) { <p class="muted">El conjunto está preparado. La carga de archivos estará disponible en el siguiente incremento.</p> }
          </section>
          @if (session.job(); as job) {
            <section class="workspace-card" aria-live="polite"><div class="section-heading"><h2>{{ jobStatus[job.status] }}</h2>@if (session.jobActive()) { <button class="secondary" (click)="session.cancelJob()" [disabled]="session.pending()">Cancelar trabajo</button> }</div>
              @if (job.progress.total > 0) { <progress [value]="job.progress.completed" [max]="job.progress.total"></progress><p>{{ job.progress.completed }} de {{ job.progress.total }}</p> }
              @if (!job.progress.complete) { <p class="muted">Progreso incompleto. No representa un resultado final de validación.</p> }
              @for (diagnostic of job.diagnostics; track $index) { <p>{{ diagnostic.message }}</p> }
            </section>
          }
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
  name = '';
  readonly jobStatus: Record<JobStatus, string> = { queued: 'Trabajo pendiente', running: 'Trabajo en curso', succeeded: 'Trabajo terminado', failed: 'No se pudo completar', cancelled: 'Trabajo cancelado', timed_out: 'Plazo de ejecución agotado' };
  constructor() { void this.session.connect(); }
  async close(): Promise<void> { await this.session.close(); if (!this.session.workspace()) this.confirmClose.set(false); }
}
