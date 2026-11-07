import { afterEveryRender, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, effect, inject, input, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule } from '@angular/material/paginator';
import { MatTableModule } from '@angular/material/table';
import { MatRadioModule } from '@angular/material/radio';
import type { DirectionReviewDecision, ValidationResultsPageDTO } from '@ce/contracts';
import { DirectionsStore } from './directions.store';
import { versionLabel } from '../core/display';

@Component({
  selector: 'ce-directions', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule, MatPaginatorModule, MatTableModule, MatRadioModule],
  templateUrl: './directions.component.html',
  styles: [`.conflict-card{border:1px solid #ccd7e4;border-radius:12px;padding:20px;margin:16px 0;background:#fff}.conflict-title{display:flex;gap:12px;justify-content:space-between;align-items:start;flex-wrap:wrap}.conflict-context{margin:4px 0;color:#526379;font-size:14px}.conflict-options{display:grid;gap:10px;margin:16px 0}.candidate-option{padding:12px;border:1px solid #dce2ec;border-radius:9px;background:#f8faff}.candidate-option:has(input:checked){border-color:#175caa;background:#edf4ff}.candidate-description{display:block;font-size:14px;font-weight:normal;line-height:1.5}.candidate-expression{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:13px;margin:8px 0}.candidate-detail{padding:16px;border-left:3px solid #175caa;background:#f3f7fc}.conflict-status{font-size:13px;font-weight:650;color:#405447}.choice-actions{display:flex;gap:8px;flex-wrap:wrap}.conflict-card mat-radio-group{display:grid;gap:10px}`],
})
export class DirectionsComponent {
  readonly page = input.required<ValidationResultsPageDTO>();
  readonly store = inject(DirectionsStore);
  readonly versionLabel = versionLabel;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private focusAfterConfirmation: { groupId: string; trigger: HTMLElement } | undefined;
  readonly groupStates = { conflicted: 'Elegir una regla', resolved: 'Decisión confirmada', omitted: 'No se recalculará', pending: 'Pendiente de elección' };
  readonly categories: ReadonlyArray<{ key:DirectionReviewDecision; label:string }> = [
    {key:'included',label:'Incluidas'}, {key:'omitted',label:'Omitidas'}, {key:'pending',label:'Por decidir'},
    {key:'conflicted',label:'En conflicto'}, {key:'excluded',label:'Sin destino'}, {key:'undetermined',label:'Sin determinar'},
  ];
  constructor() {
    effect(() => { const run = this.page().run; untracked(() => this.store.bind(run)); });
    afterEveryRender(() => {
      const request = this.focusAfterConfirmation; if (!request) return;
      const root = this.host.nativeElement, document = root.ownerDocument;
      const card = [...root.querySelectorAll<HTMLElement>('[data-group-id]')].find(element => element.dataset['groupId'] === request.groupId);
      const summary = card?.querySelector<HTMLElement>('[data-group-summary]'); if (!summary) return;
      this.focusAfterConfirmation = undefined;
      if (document.activeElement === request.trigger || document.activeElement === document.body && !request.trigger.isConnected) summary.focus();
    });
  }
  async confirmChoice(event: Event): Promise<void> {
    const trigger = event.currentTarget as HTMLElement, groupId = this.store.editor()?.group.groupId;
    if (!groupId || !await this.store.confirmChoice()) return;
    this.focusAfterConfirmation = { groupId, trigger }; this.changeDetector.markForCheck();
  }
}
