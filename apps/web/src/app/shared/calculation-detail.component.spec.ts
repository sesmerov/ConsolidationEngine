import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactReadDTO, ProposalDTO, RuleResultDTO, RulesPageDTO, SourceFile } from '@ce/contracts';
import { CalculationDetailComponent } from './calculation-detail.component';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';

const id = 'a4a99ec0-bb65-41f5-90d1-b857f4ebefb2', versionId = 'bfda41bd-2a55-4a80-9f22-2fc1aa89894c', producerId = '5976e981-9b8d-4e80-af2a-b1ffeced4b55', hash = 'b'.repeat(64);
const rational = (value: string, denominator = '1') => ({ numerator: value, denominator });
const numeric = (value: string, denominator = '1') => ({ kind: 'number' as const, nominal: rational(value, denominator), interval: { lo: rational(value, denominator), hi: rational(value, denominator) }, unit: 'EUR' });
const coordinate = { factKey: '[private,cell,key]', contextId: 'demo', tableCode: 'C_01.00', sheetCode: '', rowCode: '0010', columnCode: '0010', dataType: 'number' as const, unit: 'EUR', decimals: '2', axes: {}, sourceLocator: { fileId: id, sheet: 'CA1', row: 5, column: 'E' } };
const fact = (value: string): FactReadDTO => ({ factKey: coordinate.factKey, coordinate, presence: 'value', normalizedValue: rational(value), originalText: value, sourceLocator: coordinate.sourceLocator });
const files: SourceFile[] = [{ id, sha256: hash, displayName: 'informe.xlsx', kind: 'report', size: 1, importedAt: '2026-11-04T00:00:00.000Z' }];
const result = (): RuleResultDTO => ({ id: 'result-one', runId: id, versionId, profileId: 'ce-dpmxl-0.9-closed-v1', coverageOnly: false, instanceId: hash, code: 'RULE', variantIds: [hash], sourceRecordIds: [id], tables: ['C_01.00'], status: 'pass', severity: 'error', severityOriginal: 'Error', expression: '1=1', values: { left: numeric('1'), right: numeric('1'), result: { kind: 'boolean', value: true } }, readKeys: [coordinate.factKey], factReads: [fact('1')], metadataReads: [], sources: [coordinate.sourceLocator, coordinate.sourceLocator], diagnostics: [] });
const proposal = (): ProposalDTO => ({ id, previewId: versionId, directionId: hash, instanceId: hash, variantIds: [hash], binding: {}, code: 'RULE', targetKey: coordinate.factKey, before: fact('1'), after: { normalizedValue: rational('3'), originalText: '3.00', decimals: '2', unit: 'EUR' }, exactNominal: rational('3'), derivedInterval: { lo: rational('3'), hi: rational('3') }, readKeys: [coordinate.factKey], predecessorIds: [producerId], metadataReads: [], sources: [coordinate.sourceLocator], state: 'available', diagnostics: [], calculation: { expression: 'source + 1', sourceValue: numeric('3'), reads: [{ fact: fact('2'), fromProposalId: producerId }] } });
const page = (items: unknown[], nextCursor: string | null = null) => ({ items, total: items.length, nextCursor, versionId }) as unknown as RulesPageDTO;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('calculation and source detail', () => {
  const workspace = signal<{ id: string } | null>({ id });
  let api: { rules: ReturnType<typeof vi.fn>; preview: ReturnType<typeof vi.fn> };
  beforeEach(() => { workspace.set({ id }); api = { rules: vi.fn().mockResolvedValue(page([])), preview: vi.fn().mockResolvedValue({ baseVersionId: versionId }) }; TestBed.configureTestingModule({ imports: [CalculationDetailComponent], providers: [{ provide: ApiClient, useValue: api }, { provide: SessionStore, useValue: { workspace } }] }); });
  afterEach(() => TestBed.resetTestingModule());
  function render(value: RuleResultDTO | ProposalDTO, kind: 'result' | 'proposal' = 'result') {
    const fixture = TestBed.createComponent(CalculationDetailComponent); fixture.componentRef.setInput(kind, value); fixture.componentRef.setInput('files', files); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const button = (label: string) => Array.from(root.querySelectorAll('button')).find(element => element.textContent?.trim() === label)!;
    return { fixture, root, button };
  }
  function mainText(root: HTMLElement) { const clone = root.cloneNode(true) as HTMLElement; clone.querySelectorAll('details').forEach(node => node.remove()); return clone.textContent ?? ''; }
  it('labels and focuses the region and emits close without changing selection', async () => {
    const { fixture, root, button } = render(result()); await fixture.whenStable();
    expect(root.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Cálculo y origen de RULE');
    expect(document.activeElement?.textContent).toContain('Cálculo y origen de RULE');
    const close = vi.fn(); fixture.componentInstance.closed.subscribe(close); button('Cerrar detalle').click(); expect(close).toHaveBeenCalledOnce();
  });
  it('groups repeated physical sources and keeps identifiers out of the main explanation', () => {
    const { root } = render(result()), text = mainText(root);
    expect(text).toContain('C_01.00'); expect(text).toContain('informe.xlsx');
    expect(root.querySelectorAll('[data-source-location]')).toHaveLength(1);
    expect(text).not.toContain(hash); expect(text).not.toContain(coordinate.factKey); expect(text).not.toContain(id);
  });
  it('uses retained simulated reads, marks predecessors and separates applied derivations', () => {
    const row = proposal(); const applied = { ...fact('4'), derivation: { receiptId: id, previewId: versionId, proposalId: producerId, baseVersionId: versionId } };
    const { root } = render({ ...row, calculation: { ...row.calculation!, reads: [...row.calculation!.reads, { fact: applied }] } }, 'proposal');
    const table = root.querySelector('table[aria-label="Entradas utilizadas"]')!;
    expect(table.textContent).toContain('2,00'); expect(table.textContent).not.toContain('1,00'); expect(table.textContent).toContain('Calculado por una propuesta antecesora');
    expect(table.textContent).toContain('Recalculado en una aplicación anterior'); expect(mainText(root)).not.toContain(producerId);
  });
  it('does not invent source reads for a legacy proposal without captured calculation', () => {
    const { calculation: _calculation, ...old } = proposal(); const { root } = render(old, 'proposal');
    expect(root.textContent).toContain('Esta propuesta no conserva el cálculo detallado');
    expect(root.querySelector('table[aria-label="Entradas utilizadas"]')).toBeNull();
  });
  it('renders typed values, empty text and absence literally without HTML execution', () => {
    const { normalizedValue: _value, originalText: _text, ...empty } = fact('0');
    const text = '<img src=x onerror=alert(1)>'; const row = { ...result(), presentation: { description: '<b>Descripción literal</b>' }, values: { left: { kind: 'text' as const, value: text }, right: { kind: 'text' as const, value: '' }, result: { kind: 'date' as const, value: '2024-02-29' } }, factReads: [{ ...empty, presence: 'explicit_null' as const }] };
    const { root } = render(row); expect(root.textContent).toContain(text); expect(root.textContent).toContain('Texto vacío'); expect(root.textContent).toContain('29/02/2024'); expect(root.textContent).toContain('Sin dato');
    expect(root.querySelector('img,b')).toBeNull();
  });
  it('keeps exact nominal and intervals in expandable technical detail', () => {
    const row = { ...proposal(), exactNominal: rational('1', '3'), after: { normalizedValue: rational('33', '100'), originalText: '0.33', decimals: '2', unit: 'EUR' }, derivedInterval: { lo: rational('1', '4'), hi: rational('1', '2') } };
    const { fixture, root } = render(row, 'proposal'); expect(mainText(root)).toContain('Redondeado'); expect(mainText(root)).not.toContain('1/3');
    const detail = root.querySelector<HTMLDetailsElement>('details[data-technical]')!; expect(detail.open).toBe(false); detail.open = true; detail.dispatchEvent(new Event('toggle')); fixture.detectChanges();
    expect(detail.textContent).toContain('1/3'); expect(detail.textContent).toContain('0,25'); expect(detail.textContent).toContain('0,5');
  });
  it('loads all catalog alternatives on demand and filters exact variant IDs across pages', async () => {
    api.rules.mockResolvedValueOnce(page([{ variantId: 'c'.repeat(64), originalFields: { Description: { value: 'Wrong variant' } }, sourceLocator: {} }, { variantId: hash, originalFields: { Description: { value: 'Primera <b>literal</b>' } }, sourceLocator: coordinate.sourceLocator }], 'cursor'))
      .mockResolvedValueOnce(page([{ variantId: hash, originalFields: { Description: { value: 'Segunda' } }, sourceLocator: coordinate.sourceLocator }]));
    const { fixture, root, button } = render(result()); expect(api.rules).not.toHaveBeenCalled(); button('Ver descripciones del catálogo').click(); await fixture.whenStable(); fixture.detectChanges();
    expect(api.rules).toHaveBeenNthCalledWith(1, id, versionId, { code: 'RULE' }); expect(api.rules).toHaveBeenNthCalledWith(2, id, versionId, { code: 'RULE', cursor: 'cursor' });
    expect(root.textContent).toContain('Primera <b>literal</b>'); expect(root.textContent).toContain('Segunda'); expect(root.textContent).not.toContain('Wrong variant'); expect(root.querySelector('b')).toBeNull();
  });
  it('resolves proposal catalog context from its historical preview, never the current snapshot', async () => {
    api.preview.mockResolvedValue({ baseVersionId: 'historical-version' }); const { fixture, button } = render(proposal(), 'proposal');
    button('Ver descripciones del catálogo').click(); await fixture.whenStable();
    expect(api.preview).toHaveBeenCalledWith(id, versionId); expect(api.rules).toHaveBeenCalledWith(id, 'historical-version', { code: 'RULE' });
  });
  it('discards alternative responses after the selected result or workspace changes', async () => {
    const request = deferred<RulesPageDTO>(); api.rules.mockReturnValue(request.promise);
    const { fixture, root, button } = render(result()); button('Ver descripciones del catálogo').click();
    fixture.componentRef.setInput('result', { ...result(), id: 'another', code: 'OTHER' }); workspace.set({ id: 'other-workspace' }); fixture.detectChanges();
    request.resolve(page([{ variantId: hash, originalFields: { Description: { value: 'Stale description' } }, sourceLocator: {} }])); await fixture.whenStable(); fixture.detectChanges();
    expect(root.textContent).not.toContain('Stale description'); expect(root.textContent).toContain('OTHER');
  });
  it('does not publish partial alternatives on a repeated cursor or after destruction', async () => {
    api.rules.mockResolvedValue(page([{ variantId: hash, originalFields: { Description: { value: 'Partial description' } }, sourceLocator: {} }], 'repeated'));
    const { fixture, root, button } = render(result()); button('Ver descripciones del catálogo').click(); await fixture.whenStable(); fixture.detectChanges();
    expect(root.textContent).toContain('No se pudieron consultar'); expect(root.textContent).not.toContain('Partial description'); expect(api.rules).toHaveBeenCalledTimes(2);
    const late = deferred<RulesPageDTO>(); api.rules.mockReturnValue(late.promise); button('Ver descripciones del catálogo').click(); fixture.destroy();
    late.resolve(page([{ variantId: hash, originalFields: { Description: { value: 'Late description' } }, sourceLocator: {} }])); await Promise.resolve();
    expect(fixture.componentInstance.alternatives()).toEqual([]);
  });
});
