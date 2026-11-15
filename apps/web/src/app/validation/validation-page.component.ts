import { calculationHeadingId, StageFocus, StageTitleDirective } from '../core/stage-title.directive';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import type { DoCheck } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import type { CompactRuleResultDTO, PublicValue } from '@ce/contracts';
import { versionLabel } from '../core/display';
import { isLargeValue } from '../core/public-value';
import { ResultsStore } from './results.store';
import { ResultsExportComponent } from './results-export.component';
import { CalculationDetailComponent } from '../shared/calculation-detail.component';
import { CursorPaginatorComponent } from '../shared/cursor-paginator.component';
import { ResultValueComponent } from '../shared/result-value.component';
@Component({ selector: 'ce-validation-page', standalone: true, imports: [StageTitleDirective, FormsModule, DatePipe, MatButtonModule, MatFormFieldModule, MatInputModule, MatTableModule, CursorPaginatorComponent, ResultsExportComponent, CalculationDetailComponent, ResultValueComponent], templateUrl: './validation-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class ValidationPageComponent implements DoCheck {
readonly store = inject(ResultsStore); readonly session = this.store.session; readonly versionLabel = versionLabel;
readonly detail = signal<CompactRuleResultDTO | undefined>(undefined); readonly detailLoading=signal(false); readonly detailError=signal<string|null>(null);
private detailTrigger?: HTMLElement; private detailGeneration=0; private controller?:AbortController;
private readonly focus = inject(StageFocus, { optional: true });
private readonly historySelector = viewChild('historySelector', {read: ElementRef<HTMLSelectElement>});
private readonly historyHeading = viewChild<ElementRef<HTMLElement>>('historyHeading');
ngDoCheck(): void { const select=this.historySelector()?.nativeElement; if(this.store.history().length<=1 && select && select.ownerDocument.activeElement===select) this.historyHeading()?.nativeElement.focus(); }
constructor(){effect(()=>{this.session.workspace()?.id;this.store.page();this.cancelDetail();});inject(DestroyRef).onDestroy(()=>this.cancelDetail());}
selectRun(id: string): void { this.closeDetail(); this.store.selectRun(id); }
row(value:PublicValue<CompactRuleResultDTO>):CompactRuleResultDTO|undefined{return isLargeValue(value)?undefined:value;}
code(value:PublicValue<CompactRuleResultDTO>):string{return this.row(value)?.code||'Resultado detallado';}
description(value:PublicValue<CompactRuleResultDTO>):string{const text=this.row(value)?.presentation?.description;return typeof text==='string'?text:text?'Descripción disponible en el detalle':'';}
statusLabel(value:PublicValue<CompactRuleResultDTO>):string{const row=this.row(value);return row?this.store.labels[row.status]:'Consultar detalle';}
policyLabel(value:PublicValue<CompactRuleResultDTO>):string{const mode=this.row(value)?.recalculationPolicy?.mode;return mode==='validation_only'?'Solo validación':mode==='standard'?'Revisión en Recalcular':'Capacidad no disponible';}
async openDetail(row:PublicValue<CompactRuleResultDTO>,event:Event):Promise<void>{
 this.cancelDetail();this.detailTrigger=event.currentTarget as HTMLElement;const generation=++this.detailGeneration,controller=this.controller=new AbortController();this.detailLoading.set(true);
 try{const result=await this.store.resolveResult(row,controller.signal);if(generation!==this.detailGeneration)return;if(this.detailTrigger?.ownerDocument.activeElement===this.detailTrigger)this.focus?.request(calculationHeadingId(result.id));this.detail.set(result);}
 catch{if(generation===this.detailGeneration)this.detailError.set('No se pudo consultar el resultado completo. Vuelve a intentarlo.');}
 finally{if(generation===this.detailGeneration)this.detailLoading.set(false);}
}
private cancelDetail():void{this.detailGeneration++;this.controller?.abort();this.detail.set(undefined);this.detailLoading.set(false);this.detailError.set(null);}
closeDetail(): void { this.cancelDetail(); this.detailTrigger?.focus(); }
}
