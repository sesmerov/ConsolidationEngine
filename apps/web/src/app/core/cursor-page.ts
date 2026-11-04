import { signal } from '@angular/core';
import { MatPaginatorIntl } from '@angular/material/paginator';
export const PAGE_SIZE = 50;
export class CursorPageError extends Error {}
/** Cursor references only. Result payloads remain in the owning store's current page. */
export class CursorPage {
  readonly index = signal(0); readonly total = signal(0);
  private cursors: (string | undefined)[] = [undefined]; private fingerprint = '';
  reset(key = ''): void { this.fingerprint = key; this.cursors = [undefined]; this.index.set(0); this.total.set(0); }
  begin(key: string, nextIndex = 0): { index: number; cursor?: string } {
    if (key !== this.fingerprint) { this.reset(key); nextIndex = 0; }
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex > 20000 || nextIndex >= this.cursors.length) throw new CursorPageError('La página solicitada no tiene un cursor válido.');
    const cursor = this.cursors[nextIndex]; return { index: nextIndex, ...(cursor ? { cursor } : {}) };
  }
  accept(index: number, total: number, nextCursor: string | null, itemCount?: number): void {
    if (!Number.isSafeInteger(total) || total < 0 || total > 1_000_000) throw new CursorPageError('El total supera el límite de 1 000 000 resultados.');
    if (!Number.isInteger(index) || index < 0 || (total === 0 ? index !== 0 : index * PAGE_SIZE >= total)) throw new CursorPageError('La página recibida queda fuera del total de resultados.');
    const expected = Math.min(PAGE_SIZE, total - index * PAGE_SIZE), hasNext = (index + 1) * PAGE_SIZE < total;
    if (itemCount !== undefined && itemCount !== expected) throw new CursorPageError('El tamaño de la página no coincide con el total de resultados.');
    if ((nextCursor !== null) !== hasNext) throw new CursorPageError('El cursor siguiente no coincide con el total de resultados.');
    if (nextCursor !== null && (!nextCursor || nextCursor.length > 8192 || !/^[\x20-\x7e]+$/.test(nextCursor))) throw new CursorPageError('El servidor devolvió un cursor no válido.');
    if (nextCursor !== null && index + 1 >= 20001) throw new CursorPageError('Se alcanzó el límite de páginas.');
    this.index.set(index); this.total.set(total);
    if (nextCursor !== null) this.cursors[index + 1] = nextCursor; else this.cursors.length = index + 1;
  }
}
export function spanishPaginator(): MatPaginatorIntl {
  const intl = new MatPaginatorIntl(); intl.nextPageLabel = 'Siguiente'; intl.previousPageLabel = 'Anterior'; intl.itemsPerPageLabel = 'Filas por página';
  intl.getRangeLabel = (page, size, length) => length ? `${page * size + 1}–${Math.min((page + 1) * size, length)} de ${length}` : '0 resultados';
  return intl;
}
