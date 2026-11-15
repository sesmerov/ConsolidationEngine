import { afterEveryRender, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import type { CompactRuleResultDTO, ResultExplanationDTO, ResultExplanationPageDTO, ResultExplanationSection } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { CursorPage, CursorPageError } from '../core/cursor-page';
import { calculationHeadingId, StageFocus } from '../core/stage-title.directive';
import { CursorPaginatorComponent } from './cursor-paginator.component';
import { ResultValueComponent } from './result-value.component';

@Component({ selector: 'ce-result-explanation', standalone: true, imports: [MatButtonModule, MatTableModule, CursorPaginatorComponent, ResultValueComponent],
  styles: ['.detail-actions{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0}.detail-actions [aria-pressed="true"]{background:#e8f0ff}.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.detail-grid dt{color:#526379;font-size:13px}.detail-grid dd{margin:6px 0 0}'],
  changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './result-explanation.component.html' })
export class ResultExplanationComponent {
  readonly result = input.required<CompactRuleResultDTO>(); readonly closed = output<void>();
  private readonly api = inject(ApiClient); private readonly session = inject(SessionStore); private readonly focus = inject(StageFocus,{optional:true});
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading'); private generation = 0;
  readonly detail = signal<ResultExplanationDTO|null>(null); readonly loading = signal(false); readonly error = signal<string|null>(null);
  readonly section = signal<ResultExplanationSection|null>(null); readonly page = signal<ResultExplanationPageDTO|null>(null); readonly pageLoading = signal(false); readonly pagination = new CursorPage();
  readonly title = computed(() => `Cálculo y origen de ${this.result().code}`); readonly headingId = computed(() => calculationHeadingId(this.result().id));
  readonly operands = computed(() => { const values=this.detail()?.values; return ([['Lado izquierdo',values?.left],['Lado derecho',values?.right],['Resultado',values?.result]] as const).flatMap(([label,value])=>value ? [{label,value}] : []); });
  readonly sections = computed(() => { const counts=this.detail()?.counts; return counts ? [
    {id:'reads' as const,label:'Entradas utilizadas',count:counts.reads}, {id:'metadata' as const,label:'Indicadores utilizados',count:counts.metadataReads},
    {id:'origins' as const,label:'Archivos y celdas de origen',count:counts.origins}, {id:'diagnostics' as const,label:'Motivos y avisos',count:counts.diagnostics},
    {id:'descriptions' as const,label:'Descripciones del catálogo',count:counts.descriptions}].filter(item=>item.count>0) : []; });
  readonly sectionLabel=computed(()=>this.sections().find(item=>item.id===this.section())?.label??'Detalle de la explicación');
  constructor() {
    effect(() => { const row=this.result(), workspaceId=this.session.workspace()?.id; this.generation++; this.detail.set(null); this.page.set(null); this.section.set(null); this.pagination.reset(); this.pageLoading.set(false); this.error.set(null); if(workspaceId) void this.loadDetail(row,workspaceId); });
    afterEveryRender(()=>{ const heading=this.heading(); if(heading) this.focus?.fulfill(heading.nativeElement); });
    inject(DestroyRef).onDestroy(()=>{this.generation++;});
  }
  retry():void { const workspaceId=this.session.workspace()?.id; if(workspaceId) void this.loadDetail(this.result(),workspaceId); }
  private async loadDetail(row:CompactRuleResultDTO,workspaceId:string):Promise<void> {
    const generation=++this.generation;this.loading.set(true);this.error.set(null);
    try { const detail=await this.api.resultExplanation(workspaceId,row.runId,row.id);if(generation!==this.generation||workspaceId!==this.session.workspace()?.id)return;
      if(detail.workspaceId!==workspaceId||detail.id!==row.id||detail.runId!==row.runId||detail.versionId!==row.versionId)throw new CursorPageError('El detalle no corresponde al resultado elegido.');this.detail.set(detail);
    }catch(error){if(generation===this.generation)this.error.set(error instanceof CursorPageError?error.message:'No se pudo consultar el detalle. Vuelve a intentarlo.');}
    finally{if(generation===this.generation)this.loading.set(false);}
  }
  async loadSection(section:ResultExplanationSection,index=0):Promise<void> {
    const row=this.detail(),workspaceId=this.session.workspace()?.id;if(!row||!workspaceId)return;
    const generation=++this.generation; this.pageLoading.set(true);this.error.set(null);this.section.set(section);this.page.set(null);
    try { const request=this.pagination.begin(JSON.stringify([workspaceId,row.runId,row.id,section]),index);
      const page=await this.api.resultExplanationItems(workspaceId,row.runId,row.id,section,request.cursor);if(generation!==this.generation||workspaceId!==this.session.workspace()?.id)return;
      if(page.workspaceId!==workspaceId||page.runId!==row.runId||page.resultId!==row.id||page.versionId!==row.versionId||page.section!==section)throw new CursorPageError('La explicación ha cambiado. Vuelve a abrir el detalle.');
      this.pagination.accept(request.index,page.total,page.nextCursor,page.items.length);this.page.set(page);
    }catch(error){if(generation===this.generation)this.error.set(error instanceof CursorPageError?error.message:'No se pudo consultar esta parte de la explicación. Vuelve a intentarlo.');}
    finally{if(generation===this.generation)this.pageLoading.set(false);}
  }
  close():void{this.generation++;this.closed.emit();}
}
