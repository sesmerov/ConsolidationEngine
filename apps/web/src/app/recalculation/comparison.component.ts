import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import { CursorPaginatorComponent } from '../shared/cursor-paginator.component';
import { CursorPage, CursorPageError } from '../core/cursor-page';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
import type { ResolvedItemsPage } from '../core/public-value';
import { calculationHeadingId, StageFocus } from '../core/stage-title.directive';
import { versionLabel } from '../core/display';
import { statusLabels } from '../core/exact-value';
import { CalculationDetailComponent } from '../shared/calculation-detail.component';
import type { CompactApplicationDetailDTO, CompactRuleResultDTO, PublicComparisonPageDTO, PublicComparisonRowDTO, PublicApplicationChangesPageDTO, ValidationStatus } from '@ce/contracts';
@Component({ selector: 'ce-comparison', standalone: true, imports: [MatButtonModule, MatTableModule, CursorPaginatorComponent, CalculationDetailComponent], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './comparison.component.html' })
export class ComparisonComponent {
  readonly session=inject(SessionStore);private readonly api=inject(ApiClient);readonly versionLabel=versionLabel;
  readonly page=input.required<ResolvedItemsPage<PublicComparisonPageDTO>>();readonly detail=input<CompactApplicationDetailDTO|null>(null);readonly loading=input(false);readonly pagination=input(new CursorPage());readonly changedOnly=input(true);
  readonly pageChange=output<number>();readonly toggleAll=output<void>();readonly more=output<void>();
  readonly labels=statusLabels;readonly opened=signal<PublicComparisonRowDTO|null>(null);private trigger?:HTMLElement;
  private readonly focus=inject(StageFocus,{optional:true});private generation=0;private readonly receiptId=computed(()=>this.page().receipt.id);
  readonly changesPage=signal<ResolvedItemsPage<PublicApplicationChangesPageDTO>|null>(null);readonly changesLoading=signal(false);readonly changesError=signal<string|null>(null);readonly changesPagination=new CursorPage();
  readonly statuses:readonly ValidationStatus[]=['pass','fail','not_applicable','not_evaluable','error'];
  constructor(){effect(()=>{const receiptId=this.receiptId();this.session.workspace()?.id;this.generation++;this.changesPage.set(null);this.changesPagination.reset();this.opened.set(null);void this.loadChanges(0,receiptId);});inject(DestroyRef).onDestroy(()=>{this.generation++;});}
  sides(row:PublicComparisonRowDTO){return [{label:'Antes',result:row.before},{label:'Después',result:row.after}];}
  code(row:PublicComparisonRowDTO):string{return row.after?.code||row.before?.code||'Sin código';}
  description(row:PublicComparisonRowDTO):string{const value=row.after?.presentation?.description||row.before?.presentation?.description;return typeof value==='string'?value:value?'Descripción completa disponible en el detalle':'';}
  state(result:CompactRuleResultDTO|undefined):string{return result?this.labels[result.status]:'Sin registro';}
  open(row:PublicComparisonRowDTO,event:Event):void{this.trigger=event.currentTarget as HTMLElement;const first=row.before??row.after;if(first)this.focus?.request(calculationHeadingId(first.id));this.opened.set(row);}
  close():void{this.opened.set(null);this.trigger?.focus();}
  async loadChanges(index=0,receiptId=this.page().receipt.id):Promise<void>{
    const workspaceId=this.session.workspace()?.id;if(!workspaceId)return;const generation=++this.generation;this.changesLoading.set(true);this.changesError.set(null);
    try{const request=this.changesPagination.begin(JSON.stringify([workspaceId,receiptId]),index),page=await this.api.applicationChanges(workspaceId,receiptId,request.cursor);
      if(generation!==this.generation||workspaceId!==this.session.workspace()?.id||receiptId!==this.page().receipt.id)return;
      if(page.workspaceId!==workspaceId||page.receiptId!==receiptId||page.versionId!==this.page().receipt.newVersionId)throw new CursorPageError('Los cambios no corresponden a esta aplicación.');
      this.changesPagination.accept(request.index,page.total,page.nextCursor,page.items.length);this.changesPage.set(page);
    }catch(error){if(generation===this.generation)this.changesError.set(error instanceof CursorPageError?error.message:'No se pudieron consultar los valores modificados. Vuelve a intentarlo.');}
    finally{if(generation===this.generation)this.changesLoading.set(false);}
  }
}
