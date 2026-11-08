import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { ValidationRunDTO } from '@ce/contracts';
import { SessionStore } from '../core/session.store';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';
@Component({ selector: 'ce-results-export', standalone: true, imports: [MatButtonModule], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="export-actions" aria-label="Guardar resultados"><button mat-button (click)="open()" [disabled]="run().status === 'running'">Ir a Descargar resultados</button></section>` })
export class ResultsExportComponent {
  readonly run = input.required<ValidationRunDTO>();
  private readonly session = inject(SessionStore); private readonly view = inject(WorkspaceViewStore);
  open(): void { const workspaceId = this.session.workspace()?.id; if (workspaceId) this.view.requestDownload({ workspaceId, versionId: this.run().versionId, kind: 'results', runId: this.run().id }); }
}
