import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorPage } from '../core/cursor-page';
import { CursorPaginatorComponent } from './cursor-paginator.component';

describe('cursor paginator ranges', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('uses real offsets and keeps next enabled when a byte-limited page has fewer than50 rows', async () => {
    const cursor = new CursorPage(); cursor.begin('rows'); cursor.accept(0, 60, 'second', 7);
    const fixture = TestBed.createComponent(CursorPaginatorComponent); fixture.componentRef.setInput('cursor', cursor); fixture.detectChanges(); await fixture.whenStable();
    const change = vi.fn(); fixture.componentInstance.pageChange.subscribe(change);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('1–7 de 60');
    (root.querySelector('button[aria-label="Siguiente"]') as HTMLButtonElement).click(); expect(change).toHaveBeenLastCalledWith(1);
    cursor.accept(1, 60, 'third', 3); fixture.detectChanges(); await fixture.whenStable();
    expect(root.textContent).toContain('8–10 de 60');
    (root.querySelector('button[aria-label="Anterior"]') as HTMLButtonElement).click(); expect(change).toHaveBeenLastCalledWith(0);
  });
  it('exposes a first-page reset after bounded history eviction without falsifying the visible range', async () => {
    const cursor = new CursorPage(); cursor.begin('rows');
    for (let index = 0; index < 300; index++) cursor.accept(index, 301, 'next-' + index, 1);
    const fixture = TestBed.createComponent(CursorPaginatorComponent); fixture.componentRef.setInput('cursor', cursor); fixture.detectChanges(); await fixture.whenStable();
    const change = vi.fn(); fixture.componentInstance.pageChange.subscribe(change);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('300–300 de 301');
    Array.from(root.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Primera página')!.click(); expect(change).toHaveBeenCalledWith(0);
  });
});
