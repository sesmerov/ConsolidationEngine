import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatPaginatorModule } from '@angular/material/paginator';
import type { CompactPreviewDTO, ProposalSelectionSummaryDTO } from '@ce/contracts';
import { ApplyStore } from './apply.store';
import { ExactValueComponent } from '../core/exact-value.component';
@Component({ selector: 'ce-apply', standalone: true, imports: [MatButtonModule, MatCheckboxModule, MatPaginatorModule, ExactValueComponent], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './apply.component.html' })
export class ApplyComponent {
readonly preview = input.required<CompactPreviewDTO | null>();
readonly selection = input<ProposalSelectionSummaryDTO | null>(null); readonly selectionBusy = input(false);
readonly store = inject(ApplyStore);
readonly session = this.store.session;
readonly showConfirmation = computed(() => {
  const preview = this.preview();
  return preview?.state === 'ready' && preview.baseVersionId === this.session.versionId() && (this.selection()?.selectedCount ?? 0) > 0;
});
readonly acknowledged = this.store.acknowledged;
readonly pending = this.store.pending;
readonly error = this.store.error;
readonly uncertain = this.store.uncertain;
readonly rejected = this.store.rejected;
readonly canApply = this.store.canApply;
readonly apply = this.store.apply.bind(this.store);
readonly retry = this.store.retry.bind(this.store);
readonly target = this.store.target.bind(this.store);
readonly noChange = this.store.noChange.bind(this.store);
constructor() {
  effect(() => {
    this.store.preview.set(this.preview());
    this.store.selection.set(this.selection());
    this.store.selectionBusy.set(this.selectionBusy());
  });
}
}
