import { afterEveryRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import type { ProposalExplanationDTO, ProposalExplanationPageDTO, ProposalExplanationSection, ProposalExplanationItemDTO, ProposalOperandDTO, ProposalExplanationOriginDTO, ProposalExplanationDiagnosticDTO, ProposalExplanationDescriptionDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { StageFocus, calculationHeadingId } from '../core/stage-title.directive';
import { CursorPage, CursorPageError } from '../core/cursor-page';
import { CursorPaginatorComponent } from '../shared/cursor-paginator.component';
import { decimalText, normalizedText, validationText } from '../core/exact-value';

@Component({ selector: 'ce-proposal-explanation', standalone: true, imports: [MatButtonModule, MatTableModule, CursorPaginatorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './proposal-explanation.component.html',
  styles: [`.expression{white-space:pre-wrap;overflow-wrap:anywhere}.detail-sections{display:flex;gap:8px;flex-wrap:wrap}.detail-sections [aria-pressed=true]{background:#e5efff}.detail-nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.data-table td{max-width:36ch}`] })
export class ProposalExplanationComponent {
  readonly explanation = input.required<ProposalExplanationDTO>(); readonly closed = output<void>();
  private readonly api = inject(ApiClient); private readonly session = inject(SessionStore);
  private readonly focus = inject(StageFocus, { optional: true }); private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  readonly section = signal<ProposalExplanationSection>('operands'); readonly page = signal<ProposalExplanationPageDTO | null>(null);
  readonly loading = signal(false); readonly error = signal<string | null>(null); readonly canPrevious = signal(false);
  private generation = 0; readonly pagination=new CursorPage();
  readonly title = computed(() => 'Cálculo y origen de ' + this.explanation().code);
  readonly headingId = computed(() => calculationHeadingId(this.explanation().proposalId));
  readonly operandRows = computed(() => this.page()?.section === 'operands' ? this.page()!.items as readonly ProposalOperandDTO[] : []);
  readonly originRows = computed(() => this.page()?.section === 'origins' ? this.page()!.items as readonly ProposalExplanationOriginDTO[] : []);
  readonly diagnosticRows = computed(() => this.page()?.section === 'diagnostics' ? this.page()!.items as readonly ProposalExplanationDiagnosticDTO[] : []);
  readonly descriptionRows = computed(() => this.page()?.section === 'descriptions' ? this.page()!.items as readonly ProposalExplanationDescriptionDTO[] : []);
  readonly decimalText = decimalText; readonly normalizedText = normalizedText; readonly validationText = validationText;
  readonly columns = ['coordinate', 'value', 'origin'];
  constructor() {
    effect(() => { this.explanation(); this.session.workspace()?.id; this.reset(); void this.load(); });
    afterEveryRender(() => { const heading = this.heading(); if (heading) this.focus?.fulfill(heading.nativeElement); });
    inject(DestroyRef).onDestroy(() => { this.generation++; });
  }
  private reset(): void { this.generation++; this.page.set(null); this.error.set(null); this.pagination.reset(); this.canPrevious.set(false); }
  selectSection(section: ProposalExplanationSection): void { this.section.set(section); this.reset(); void this.load(); }
  async load(index = this.pagination.index()): Promise<void> {
    const workspace = this.session.workspace()?.id, detail = this.explanation(); if (!workspace) return;
    const generation = ++this.generation, section = this.section(); this.loading.set(true); this.error.set(null);
    try {
      const request=this.pagination.begin(JSON.stringify([workspace,detail.previewId,detail.proposalId,detail.revision,section]),index),cursor=request.cursor;
      const page = await this.api.proposalExplanationItems(workspace, detail.previewId, detail.proposalId, { section, ...(cursor ? { cursor } : {}) });
      if (generation !== this.generation || workspace !== this.session.workspace()?.id) return;
      if (page.revision !== detail.revision || page.state !== detail.state) { this.error.set('La selección ha cambiado. Cierra el detalle y vuelve a abrirlo para consultar la revisión actual.'); return; }
      this.pagination.accept(request.index,page.total,page.nextCursor,page.items.length);this.page.set(page);this.canPrevious.set(this.pagination.index()>0);
    } catch (error) { if (generation === this.generation) this.error.set(error instanceof CursorPageError?error.message:error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message : 'No se pudo consultar el detalle. Vuelve a intentarlo.'); }
    finally { if (generation === this.generation) this.loading.set(false); }
  }
  previous(): void { void this.load(this.pagination.index() - 1); }
  next(): void { if (this.page()?.nextCursor) void this.load(this.pagination.index() + 1); }
  close(): void { this.generation++; this.closed.emit(); }
  coordinate(row: { tableCode: string; sheetCode: string; rowCode: string; columnCode: string }): string { return [row.tableCode, row.sheetCode ? 's' + row.sheetCode : '', 'r' + row.rowCode, 'c' + row.columnCode].filter(Boolean).join(' · '); }
  origin(row: ProposalOperandDTO): string { return row.originKind === 'proposal' ? 'Valor recalculado por ' + (row.fromProposalCode ?? 'una propuesta antecesora') : row.originKind === 'application' ? 'Valor de una aplicación anterior' : 'Valor del informe'; }
}
