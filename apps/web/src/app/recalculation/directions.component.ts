import { ChangeDetectionStrategy, Component, effect, inject, input, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule } from '@angular/material/paginator';
import { MatTableModule } from '@angular/material/table';
import type { DirectionReviewDecision, ValidationResultsPageDTO } from '@ce/contracts';
import { DirectionsStore } from './directions.store';
import { versionLabel } from '../core/display';

@Component({
  selector: 'ce-directions', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule, MatPaginatorModule, MatTableModule],
  templateUrl: './directions.component.html',
})
export class DirectionsComponent {
  readonly page = input.required<ValidationResultsPageDTO>();
  readonly store = inject(DirectionsStore);
  readonly versionLabel = versionLabel;
  readonly categories: ReadonlyArray<{ key:DirectionReviewDecision; label:string }> = [
    {key:'included',label:'Incluidas'}, {key:'omitted',label:'Omitidas'}, {key:'pending',label:'Por decidir'},
    {key:'conflicted',label:'En conflicto'}, {key:'excluded',label:'Sin destino'}, {key:'undetermined',label:'Sin determinar'},
  ];
  constructor() {
    effect(() => { const run = this.page().run; untracked(() => this.store.bind(run)); });
  }
}
