import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { StageFocus, StageTitleDirective } from './stage-title.directive';

@Component({ standalone: true, imports: [StageTitleDirective], providers: [StageFocus], template: `<nav aria-label="Etapas"><button id="load" aria-current="step">Cargar</button><button id="recalculate">Recalcular</button></nav><input aria-label="Otro campo"/>@if (visible()) { <h2 id="import-title" tabindex="-1" ceStageTitle>Cargar archivos</h2> }` })
class DeferredHeadingHost { readonly visible = signal(false); readonly focus = inject(StageFocus); }
afterEach(() => TestBed.resetTestingModule());
describe('deferred stage heading focus', () => {
  it('does not steal a navigation button focus when the initial deferred stage arrives after reload', async () => {
    TestBed.configureTestingModule({ imports: [DeferredHeadingHost] }); const fixture = TestBed.createComponent(DeferredHeadingHost); fixture.detectChanges(); await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('#recalculate') as HTMLButtonElement; button.focus(); expect(document.activeElement).toBe(button);
    fixture.componentInstance.visible.set(true); fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(button);
  });
  it('moves focus to a deferred heading after explicit navigation and leaves later focus alone', async () => {
    TestBed.configureTestingModule({ imports: [DeferredHeadingHost] }); const fixture = TestBed.createComponent(DeferredHeadingHost); fixture.detectChanges(); await fixture.whenStable();
    const trigger = fixture.nativeElement.querySelector('#load') as HTMLButtonElement; trigger.focus(); fixture.componentInstance.focus.request('import-title');
    fixture.componentInstance.visible.set(true); fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('h2'));
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement; input.focus(); fixture.detectChanges(); await fixture.whenStable(); expect(document.activeElement).toBe(input);
  });
  it('cancels a pending focus request if the user visits another control, even after returning to its trigger', async () => {
    TestBed.configureTestingModule({ imports: [DeferredHeadingHost] }); const fixture = TestBed.createComponent(DeferredHeadingHost); fixture.detectChanges(); await fixture.whenStable();
    const trigger = fixture.nativeElement.querySelector('#load') as HTMLButtonElement, input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    trigger.focus(); fixture.componentInstance.focus.request('import-title'); input.focus(); trigger.focus();
    fixture.componentInstance.visible.set(true); fixture.detectChanges(); await fixture.whenStable(); expect(document.activeElement).toBe(trigger);
  });
  it('does not focus a stale heading when a different stage was requested', async () => {
    TestBed.configureTestingModule({ imports: [DeferredHeadingHost] }); const fixture = TestBed.createComponent(DeferredHeadingHost); fixture.detectChanges(); await fixture.whenStable();
    const trigger = fixture.nativeElement.querySelector('#recalculate') as HTMLButtonElement; trigger.focus(); fixture.componentInstance.focus.request('preview-title');
    fixture.componentInstance.visible.set(true); fixture.detectChanges(); await fixture.whenStable(); expect(document.activeElement).toBe(trigger);
  });
  it('focuses an already mounted heading on explicit reactivation', async () => {
    TestBed.configureTestingModule({ imports: [DeferredHeadingHost] }); const fixture = TestBed.createComponent(DeferredHeadingHost); fixture.componentInstance.visible.set(true); fixture.detectChanges(); await fixture.whenStable();
    const trigger = fixture.nativeElement.querySelector('#load') as HTMLButtonElement; trigger.focus(); fixture.componentInstance.focus.request('import-title');
    await new Promise(resolve => setTimeout(resolve, 0)); expect(document.activeElement).toBe(fixture.nativeElement.querySelector('h2'));
  });
});
