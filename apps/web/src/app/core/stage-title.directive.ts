import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, ElementRef, Injectable, afterNextRender, inject } from '@angular/core';
export const calculationHeadingId = (id: string): string => 'calculation-heading-' + id;
/** Scoped to the workspace: loading a chunk alone is never an instruction to move focus. */
@Injectable()
export class StageFocus {
  private readonly document = inject(DOCUMENT);
  private pending: { id: string; origin: Element | null } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly moved = (event: FocusEvent): void => {
    if (this.pending && event.target !== this.pending.origin) this.clear();
  };
  constructor() { inject(DestroyRef).onDestroy(() => this.clear()); }
  request(id: string): void {
    this.clear(); this.pending = { id, origin: this.document.activeElement };
    this.document.addEventListener('focusin', this.moved);
    // Also handle activating the already mounted stage; deferred stages fulfill on render.
    this.timer = setTimeout(() => { this.timer = undefined; const title = this.document.getElementById(id); if (title) this.fulfill(title); }, 0);
  }
  fulfill(title: HTMLElement): void {
    const request = this.pending;
    if (!request || request.id !== title.id || !title.isConnected) return;
    const active = this.document.activeElement;
    if (active !== request.origin && !(active === this.document.body && !request.origin?.isConnected)) { this.clear(); return; }
    this.clear(); title.focus();
  }
  private clear(): void {
    this.pending = undefined;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.document.removeEventListener('focusin', this.moved);
  }
}
/** A deferred heading fulfills only an explicit navigation request still owned by its trigger. */
@Directive({ selector: '[ceStageTitle]', standalone: true })
export class StageTitleDirective {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly focus = inject(StageFocus, { optional: true });
  constructor() { afterNextRender(() => this.focus?.fulfill(this.element.nativeElement)); }
}
