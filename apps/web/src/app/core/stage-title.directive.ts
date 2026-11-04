import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';
/** A deferred stage receives focus only once its actual heading exists. */
@Directive({ selector: '[ceStageTitle]', standalone: true })
export class StageTitleDirective {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  constructor() { afterNextRender(() => this.element.nativeElement.focus()); }
}
