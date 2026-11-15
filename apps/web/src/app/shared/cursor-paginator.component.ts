import { ChangeDetectionStrategy, Component, effect, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatPaginatorIntl, MatPaginatorModule } from '@angular/material/paginator';
import { CursorPage, spanishPaginator } from '../core/cursor-page';

/** Material navigation uses a bounded cursor window; its visible range always reports actual row offsets. */
@Component({ selector: 'ce-cursor-paginator', standalone: true, imports: [MatButtonModule, MatPaginatorModule],
  providers: [{ provide: MatPaginatorIntl, useFactory: spanishPaginator }], changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [':host{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap}'],
  template: `@if (cursor().firstAvailableIndex() > 0) { <button mat-button type="button" [disabled]="disabled()" (click)="pageChange.emit(0)">Primera página</button> }
    <mat-paginator [attr.aria-label]="label()" [length]="cursor().paginatorLength()" [pageSize]="50" [pageIndex]="cursor().paginatorIndex()"
      [hidePageSize]="true" [showFirstLastButtons]="false" [disabled]="disabled()"
      (page)="pageChange.emit(cursor().firstAvailableIndex() + $event.pageIndex)"/>` })
export class CursorPaginatorComponent {
  readonly cursor = input.required<CursorPage>(); readonly disabled = input(false); readonly label = input('Páginas de resultados'); readonly pageChange = output<number>();
  private readonly labels = inject(MatPaginatorIntl);
  constructor() { effect(() => { const range = this.cursor().rangeLabel(); this.labels.getRangeLabel = () => range; this.labels.changes.next(); }); }
}
