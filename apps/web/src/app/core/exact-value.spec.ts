import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api-client';
import { ResultsStore } from '../validation/results.store';
import { ExactValueComponent } from './exact-value.component';
import { decimalText, factText, normalizedText, roundedProposal } from './exact-value';
import type { FactReadDTO, ProposalDTO } from '@ce/contracts';
describe('exact Spanish value presentation', () => {
beforeEach(() => TestBed.configureTestingModule({ imports: [ExactValueComponent], providers: [ResultsStore, { provide: ApiClient, useValue: { runs: vi.fn() } }] }));
afterEach(() => TestBed.resetTestingModule());
it('shows a finite rational as an exact decimal without the technical interval', () => { const value = { numerator: '1', denominator: '8' }; expect(TestBed.inject(ResultsStore).value({ kind:'number', nominal:value, interval:{lo:value,hi:value},unit:'EUR' })).toBe('0,125 EUR'); });
it('keeps repeating rationals exact and preserves civil dates and empty text', () => {
const store=TestBed.inject(ResultsStore),value={numerator:'1',denominator:'3'};
expect(store.value({kind:'number',nominal:value,interval:{lo:value,hi:value},unit:''})).toBe('1/3');
expect(store.value({kind:'date',value:'2024-02-29'})).toBe('29/02/2024');
expect(store.value({kind:'text',value:''})).toBe('Texto vacío');
expect(store.value({kind:'null',dataType:'text',presence:'explicit_null'})).toBe('Sin dato');
});
it('preserves large amounts and differences below the declared display precision', () => {
expect(decimalText({numerator:'900719925474099301',denominator:'100'},'2')).toBe('9.007.199.254.740.993,01');
expect(decimalText({numerator:'10000001',denominator:'1000000'},'2')).toBe('10,000001');
expect(decimalText({numerator:'10',denominator:'1'},'2')).toBe('10,00');
expect(decimalText({numerator:'-123456789123456789',denominator:'1000'})).toBe('−123.456.789.123.456,789');
});
it('uses normalized amounts after scale, not original Excel text', () => {
const fact={presence:'value',normalizedValue:{numerator:'12000',denominator:'1'},originalText:'12',coordinate:{decimals:'2',unit:'EUR'}} as FactReadDTO;
expect(factText(fact)).toBe('12.000,00');
expect(normalizedText({numerator:'0',denominator:'1'},'2')).toBe('0,00');
expect(normalizedText(undefined)).toBe('Sin dato'); expect(normalizedText({kind:'text',value:''})).toBe('Texto vacío');
});
it('renders long and hostile text literally and leaves the complete value available to copy', () => {
const value='<img src=x onerror=alert(1)> '+ 'x'.repeat(300); const fixture=TestBed.createComponent(ExactValueComponent);
fixture.componentRef.setInput('value',{kind:'text',value});fixture.detectChanges();
expect((fixture.nativeElement as HTMLElement).querySelector('img')).toBeNull();
expect((fixture.nativeElement as HTMLElement).textContent).toContain(value);
expect((fixture.nativeElement as HTMLElement).querySelector('span')?.title).toContain(value);
});
it('keeps a civil leap date independent from timezone and marks real half-even rounding only', () => {
expect(normalizedText({kind:'date',value:'2000-02-29'})).toBe('29/02/2000');
const proposal={exactNominal:{numerator:'1',denominator:'3'},after:{normalizedValue:{numerator:'33',denominator:'100'}}} as ProposalDTO;
expect(roundedProposal(proposal)).toBe(true);
expect(roundedProposal({...proposal,exactNominal:{numerator:'33',denominator:'100'}})).toBe(false);
});
});
