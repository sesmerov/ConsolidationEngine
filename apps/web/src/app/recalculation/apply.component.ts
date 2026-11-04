import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import type { PreviewDTO, PreviewSelectionDTO, ProposalDTO, SourceFile } from '@ce/contracts';
import { ApplyStore } from './apply.store';
import { ExactValueComponent } from '../core/exact-value.component';
@Component({ selector: 'ce-apply', standalone: true, imports: [MatButtonModule, MatCheckboxModule, ExactValueComponent], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './apply.component.html' })
export class ApplyComponent {
readonly preview = input.required<PreviewDTO>(); readonly selection = input<PreviewSelectionDTO | null>(null); readonly proposals = input<readonly ProposalDTO[]>([]); readonly sources = input<readonly SourceFile[]>([]);
readonly store = inject(ApplyStore);
readonly session = this.store.session;
readonly acknowledged = this.store.acknowledged;
readonly pending = this.store.pending;
readonly error = this.store.error;
readonly uncertain = this.store.uncertain;
readonly rejected = this.store.rejected;
readonly selectedProposals = this.store.selectedProposals;
readonly canApply = this.store.canApply;
readonly apply = this.store.apply.bind(this.store);
readonly retry = this.store.retry.bind(this.store);
readonly target = this.store.target.bind(this.store);
readonly predecessor = this.store.predecessor.bind(this.store);
readonly fraction = this.store.fraction.bind(this.store);
readonly source = this.store.source.bind(this.store);
readonly noChange = this.store.noChange.bind(this.store);
constructor() { effect(() => { this.store.preview.set(this.preview()); this.store.selection.set(this.selection()); this.store.proposals.set(this.proposals()); this.store.sources.set(this.sources()); }); }
}
