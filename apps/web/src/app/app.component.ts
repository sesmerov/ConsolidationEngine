import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'ce-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <aside><span class="brand-mark">CE</span><strong>ConsolidationEngine</strong><p>Informes regulatorios</p></aside>
      <main>
        <header><p class="eyebrow">ESPACIO DE TRABAJO LOCAL</p><h1>Validación de informes</h1></header>
        <section class="empty-state" aria-labelledby="setup-heading">
          <span class="status">En preparación</span>
          <h2 id="setup-heading">La base del proyecto está lista</h2>
          <p>La carga de archivos y las validaciones se incorporarán en los siguientes incrementos.</p>
          <p class="muted">Todavía no se han cargado informes ni ejecutado reglas.</p>
        </section>
      </main>
    </div>
  `,
})
export class AppComponent {}
