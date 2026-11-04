import { StageTitleDirective } from '../core/stage-title.directive';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ExportStore } from './export.store';
@Component({ selector: 'ce-exports', standalone: true, imports: [StageTitleDirective, DatePipe, MatButtonModule, MatFormFieldModule, MatInputModule], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './exports.component.html' })
export class ExportsComponent { readonly store = inject(ExportStore);
readonly versionLabel = this.store.versionLabel;
readonly session = this.store.session;
readonly kind = this.store.kind;
readonly selectedRunId = this.store.selectedRunId;
readonly history = this.store.history;
readonly cursor = this.store.cursor;
readonly historyLoading = this.store.historyLoading;
readonly pending = this.store.pending;
readonly error = this.store.error;
readonly uncertain = this.store.uncertain;
readonly ready = this.store.ready;
readonly runs = this.store.runs;
readonly canStart = this.store.canStart;
readonly loadHistory = this.store.loadHistory.bind(this.store);
readonly start = this.store.start.bind(this.store);
readonly retry = this.store.retry.bind(this.store);
readonly download = this.store.download.bind(this.store);
}
