import { afterEveryRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import type { FactReadDTO, ProposalDTO, RuleResultDTO, SourceFile, SourceLocator, ValidationValueDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { calculationHeadingId, StageFocus } from '../core/stage-title.directive';
import { coordinateText, decimalText, factText, hasInterval, normalizedText, roundedProposal, sourceText, validationText } from '../core/exact-value';

interface ReadRow { readonly fact: FactReadDTO; readonly fromProposalId?: string }
interface Alternative { readonly description: string; readonly origins: readonly string[] }
@Component({ selector: 'ce-calculation-detail', standalone: true, imports: [MatButtonModule, MatTableModule], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './calculation-detail.component.html', styles: [`.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.detail-grid dt{font-size:13px;color:#526379}.detail-grid dd{margin:5px 0 0}.calculation-detail h3{margin:0}.expression{white-space:pre-wrap}.source-list{padding-left:20px}.source-list li{margin:8px 0}.technical-values{margin:12px 0}.data-table td{max-width:36ch}`] })
export class CalculationDetailComponent {
  private readonly api = inject(ApiClient);
  private readonly session = inject(SessionStore);
  private generation = 0;
  private readonly focus = inject(StageFocus, { optional: true });
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  readonly result = input<RuleResultDTO>();
  readonly proposal = input<ProposalDTO>();
  readonly files = input<readonly SourceFile[]>([]);
  readonly closed = output<void>();
  readonly row = computed(() => this.proposal() ?? this.result());
  readonly title = computed(() => `Cálculo y origen de ${this.row()?.code ?? ''}`);
  readonly headingId = computed(() => calculationHeadingId(this.row()?.id ?? ''));
  readonly expression = computed(() => this.proposal() ? this.proposal()?.calculation?.expression : this.result()?.expression);
  readonly precondition = computed(() => this.proposal() ? this.proposal()?.calculation?.precondition : this.result()?.precondition);
  readonly preconditionValue = computed(() => this.proposal() ? this.proposal()?.calculation?.preconditionValue : this.result()?.preconditionResult);
  readonly operands = computed(() => {
    const proposal = this.proposal();
    if (proposal) return proposal.calculation?.sourceValue ? [{ label: 'Valor de la fuente', value: proposal.calculation.sourceValue }] : [];
    const values = this.result()?.values;
    return ([['Lado izquierdo', values?.left], ['Lado derecho', values?.right], ['Resultado', values?.result]] as const)
      .flatMap(([label, value]) => value ? [{ label, value }] : []);
  });
  readonly reads = computed<readonly ReadRow[]>(() => this.proposal() ? this.proposal()?.calculation?.reads ?? [] : (this.result()?.factReads ?? []).map(fact => ({ fact })));
  readonly columns = ['coordinate', 'value', 'origin'];
  readonly origins = computed(() => {
    const locators = [...(this.row()?.sources ?? []), ...this.reads().map(read => read.fact.sourceLocator), ...(this.row()?.metadataReads ?? []).flatMap(read => read.sourceLocator ? [read.sourceLocator] : []),
      ...(this.proposal()?.before ? [this.proposal()!.before!.sourceLocator] : [])];
    const unique = new Map<string, SourceLocator>();
    for (const locator of locators) {
      const key = JSON.stringify([locator.fileId ?? '', locator.sheet ?? '', locator.row ?? '', locator.column ?? '']);
      if (!unique.has(key)) unique.set(key, locator);
    }
    return [...unique].map(([key, locator]) => ({ key, text: sourceText(locator, this.files()) }));
  });
  readonly alternatives = signal<readonly Alternative[]>([]);
  readonly alternativesLoaded = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly coordinateText = coordinateText;
  readonly decimalText = decimalText;
  readonly factText = factText;
  readonly normalizedText = normalizedText;
  readonly validationText = validationText;
  readonly roundedProposal = roundedProposal;
  readonly hasInterval = hasInterval;

  constructor() {
    effect(() => {
      this.row(); this.session.workspace()?.id;
      this.generation++; this.alternatives.set([]); this.alternativesLoaded.set(false); this.loading.set(false); this.error.set(null);
    });
    afterEveryRender(() => {
      const heading = this.heading();
      if (this.row() && heading) this.focus?.fulfill(heading.nativeElement);
    });
    inject(DestroyRef).onDestroy(() => { this.generation++; });
  }
  close(): void { this.generation++; this.closed.emit(); }
  originLabel(read: ReadRow): string {
    return read.fromProposalId ? 'Calculado por una propuesta antecesora'
      : read.fact.derivation ? 'Recalculado en una aplicación anterior'
      : read.fact.presence === 'value' ? 'Valor del informe' : 'Sin dato en el informe';
  }
  interval(value: ValidationValueDTO): string | undefined {
    return value.kind === 'number' ? `[${decimalText(value.interval.lo)} → ${decimalText(value.interval.hi)}]` : undefined;
  }
  async loadAlternatives(): Promise<void> {
    const row = this.row(), workspaceId = this.session.workspace()?.id;
    if (!row || !workspaceId || this.loading()) return;
    const generation = ++this.generation;
    const current = () => generation === this.generation && this.row() === row && this.session.workspace()?.id === workspaceId;
    this.loading.set(true); this.error.set(null);
    try {
      const versionId = 'versionId' in row ? row.versionId : (await this.api.preview(workspaceId, row.previewId)).baseVersionId;
      if (!current()) return;
      const variants = new Set(row.variantIds), found = new Map<string, Set<string>>(), cursors = new Set<string>();
      let cursor: string | undefined;
      // Catalogs are bounded to 500 source rows; no unbounded cursor walk or per-row requests.
      for (let index = 0; index < 10; index++) {
        const page = await this.api.rules(workspaceId, versionId, { code: row.code, ...(cursor ? { cursor } : {}) });
        if (!current()) return;
        for (const record of page.items) {
          if (!record.variantId || !variants.has(record.variantId)) continue;
          const field = record.originalFields.Description;
          const text = typeof field === 'string' ? field : field && typeof field === 'object' && !Array.isArray(field) && 'value' in field ? field.value : undefined;
          if (typeof text !== 'string' || !text.trim()) continue;
          const sources = found.get(text) ?? new Set<string>(); sources.add(sourceText(record.sourceLocator, this.files())); found.set(text, sources);
        }
        if (!page.nextCursor) {
          this.alternatives.set([...found].map(([description, origins]) => ({ description, origins: [...origins] }))); this.alternativesLoaded.set(true); return;
        }
        if (cursors.has(page.nextCursor) || index === 9) throw new Error('Invalid catalog pagination');
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
    } catch { if (current()) this.error.set('No se pudieron consultar las descripciones del catálogo. Puedes volver a intentarlo.'); }
    finally { if (current()) this.loading.set(false); }
  }
}
