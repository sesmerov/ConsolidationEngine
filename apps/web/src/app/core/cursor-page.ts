import { computed, signal } from '@angular/core';
import { MatPaginatorIntl } from '@angular/material/paginator';
export const PAGE_SIZE = 50;
export class CursorPageError extends Error {}
/** Cursor references only. Result payloads remain in the owning store's current page. */
export class CursorPage {
  readonly index = signal(0); readonly total = signal(0);
  readonly offset = signal(0); readonly itemCount = signal(0); readonly hasNext = signal(false); readonly firstAvailableIndex = signal(0);
  readonly rangeLabel = computed(() => this.total() ? `${this.offset() + 1}–${this.offset() + this.itemCount()} de ${this.total()}` : '0 resultados');
  readonly paginatorIndex = computed(() => this.index() - this.firstAvailableIndex());
  readonly paginatorLength = computed(() => this.hasNext() ? (this.paginatorIndex() + 1) * PAGE_SIZE + 1 : this.paginatorIndex() * PAGE_SIZE + this.itemCount());
  private positions = new Map<number, { cursor?: string; offset: number }>([[0, { offset: 0 }]]);
  private fingerprint = ''; private accepted = false;
  reset(key = ''): void {
    this.fingerprint = key; this.positions = new Map([[0, { offset: 0 }]]); this.accepted = false;
    this.index.set(0); this.total.set(0); this.offset.set(0); this.itemCount.set(0); this.hasNext.set(false); this.firstAvailableIndex.set(0);
  }
  begin(key: string, nextIndex = 0): { index: number; cursor?: string } {
    if (key !== this.fingerprint) { this.reset(key); nextIndex = 0; }
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= 1_000_000 || !this.positions.has(nextIndex)) throw new CursorPageError('La página solicitada no tiene un cursor válido. Vuelve a la primera página.');
    const cursor = this.positions.get(nextIndex)!.cursor; return { index: nextIndex, ...(cursor ? { cursor } : {}) };
  }
  accept(index: number, total: number, nextCursor: string | null, itemCount?: number): void {
    if (!Number.isSafeInteger(total) || total < 0 || total > 1_000_000) throw new CursorPageError('El total supera el límite de 1 000 000 resultados.');
    const position = this.positions.get(index);
    if (!Number.isInteger(index) || index < 0 || !position || (total === 0 ? index !== 0 : position.offset >= total)) throw new CursorPageError('La página recibida queda fuera del total de resultados.');
    if (index > 0 && this.accepted && total !== this.total()) throw new CursorPageError('Los resultados han cambiado. Vuelve a la primera página.');
    const count = itemCount ?? Math.min(PAGE_SIZE, total - position.offset), end = position.offset + count, hasNext = end < total;
    if (!Number.isInteger(count) || count < (total ? 1 : 0) || count > PAGE_SIZE || end > total) throw new CursorPageError('El tamaño de la página no coincide con el total de resultados.');
    if ((nextCursor !== null) !== hasNext) throw new CursorPageError('El cursor siguiente no coincide con el total de resultados.');
    if (nextCursor !== null && (!nextCursor || nextCursor.length > 8192 || !/^[\x20-\x7e]+$/.test(nextCursor))) throw new CursorPageError('El servidor devolvió un cursor no válido.');
    if (nextCursor !== null && [...this.positions].some(([previousIndex, value]) => previousIndex <= index && value.cursor === nextCursor)) throw new CursorPageError('El servidor repitió un cursor. Vuelve a la primera página.');
    if (index === 0 || this.positions.get(index + 1)?.cursor !== nextCursor || this.positions.get(index + 1)?.offset !== end) {
      for (const key of this.positions.keys()) if (key > index) this.positions.delete(key);
    }
    if (nextCursor !== null) this.positions.set(index + 1, { cursor: nextCursor, offset: end });
    // Retain a bounded back-history plus the first page; forward traversal remains possible for the complete result set.
    while (this.positions.size > 257) this.positions.delete([...this.positions.keys()].filter(key => key > 0).sort((a, b) => a - b)[0]!);
    const earliest = Math.min(...[...this.positions.keys()].filter(key => key > 0));
    this.firstAvailableIndex.set(index === 0 || earliest === 1 || !Number.isFinite(earliest) ? 0 : earliest);
    this.index.set(index); this.total.set(total); this.offset.set(position.offset); this.itemCount.set(count); this.hasNext.set(hasNext); this.accepted = true;
  }
}
export function spanishPaginator(): MatPaginatorIntl {
  const intl = new MatPaginatorIntl(); intl.nextPageLabel = 'Siguiente'; intl.previousPageLabel = 'Anterior'; intl.itemsPerPageLabel = 'Filas por página';
  intl.getRangeLabel = (page, size, length) => length ? `${page * size + 1}–${Math.min((page + 1) * size, length)} de ${length}` : '0 resultados';
  return intl;
}
