import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import type { ValidationResultsPageDTO } from '@ce/contracts';
import { DirectionsStore } from './directions.store';
import { policyLabel } from '../core/exact-value';
@Component({ selector: 'ce-directions', standalone: true, imports: [MatButtonModule, MatFormFieldModule, MatInputModule, MatTableModule], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './directions.component.html' })
export class DirectionsComponent {
readonly page = input.required<ValidationResultsPageDTO>(); readonly store = inject(DirectionsStore); readonly policyLabel = policyLabel;
readonly session = this.store.session;
readonly draft = this.store.draft;
readonly known = this.store.known;
readonly pending = this.store.pending;
readonly error = this.store.error;
readonly message = this.store.message;
readonly historical = this.store.historical;
readonly knownConfiguration = this.store.knownConfiguration;
readonly completeRun = this.store.completeRun;
readonly editable = this.store.editable;
readonly choices = this.store.choices;
readonly dirty = this.store.dirty;
readonly hiddenCount = this.store.hiddenCount;
readonly canSave = this.store.canSave;
readonly choose = this.store.choose.bind(this.store);
readonly clear = this.store.clear.bind(this.store);
readonly target = this.store.target.bind(this.store);
readonly reason = this.store.reason.bind(this.store);
readonly save = this.store.save.bind(this.store);
constructor() { effect(() => this.store.page.set(this.page())); }
}
