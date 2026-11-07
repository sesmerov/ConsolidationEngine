import { isRationalValue } from './common.js';
import type { Diagnostic, SnapshotContent, SourceLocator } from './common.js';
import type { Coordinate } from './report.js';

export const LANGUAGE_PROFILE_V1 = 'ce-dpmxl-0.9-closed-v1' as const;
export const LANGUAGE_PROFILE_V2 = 'ce-dpmxl-0.9-closed-v2' as const;
export type LanguageProfileId = typeof LANGUAGE_PROFILE_V1 | typeof LANGUAGE_PROFILE_V2;
export type ReportProfileId = 'ce-report-1' | 'eba-corep-of-4.0-ca1-v1' | 'eba-finrep-4.0-f0101-v1' | 'ce-demo-types-1';
export type RecalculationPolicyReason = 'CONDITIONAL' | 'TEXT' | 'DATE';
export interface RecalculationPolicyDTO {
  readonly mode: 'standard' | 'validation_only' | 'undetermined';
  readonly profileId: string;
  readonly reasons: readonly RecalculationPolicyReason[];
}
export const recalculationPolicySchema = { type: 'object', additionalProperties: false, required: ['mode', 'profileId', 'reasons'], properties: {
  mode: { enum: ['standard', 'validation_only', 'undetermined'] }, profileId: { type: 'string' },
  reasons: { type: 'array', maxItems: 3, uniqueItems: true, items: { enum: ['CONDITIONAL', 'TEXT', 'DATE'] } },
}, allOf: [{ if: { type: 'object', properties: { mode: { const: 'validation_only' } } },
  then: { type: 'object', properties: { reasons: { enum: [
    ['CONDITIONAL'], ['TEXT'], ['DATE'], ['CONDITIONAL', 'TEXT'], ['CONDITIONAL', 'DATE'], ['TEXT', 'DATE'], ['CONDITIONAL', 'TEXT', 'DATE'],
  ] } } }, else: { type: 'object', properties: { reasons: { type: 'array', maxItems: 0 } } },
}] } as const;

/** Gregorian civil date, with no instant, timezone or JavaScript Date normalization. */
export function isCivilDateV2(value: string): boolean {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = parseInt(value.slice(0, 4), 10), month = parseInt(value.slice(5, 7), 10), day = parseInt(value.slice(8, 10), 10);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/** Validate the whole value domain, including facts no rule reads; no expression is evaluated. */
export function validateProfileValues(
  content: Pick<SnapshotContent, 'profileId' | 'coordinates' | 'facts'>,
  options: { readonly check?: () => void } = {},
): readonly Diagnostic[] {
  options.check?.();
  const diagnostics: Diagnostic[] = [];
  const issue = (code: string, message: string, locator?: SourceLocator): void => {
    if (diagnostics.length < 32) diagnostics.push({ code, message, severity: 'error', ...(locator ? { locator } : {}) });
  };
  if (content.profileId !== LANGUAGE_PROFILE_V1 && content.profileId !== LANGUAGE_PROFILE_V2) {
    issue('PROFILE_MISMATCH', 'El perfil del snapshot no está admitido.'); return diagnostics;
  }
  const v1 = content.profileId === LANGUAGE_PROFILE_V1;
  const coordinates = new Map<string, Coordinate>();
  for (const coordinate of content.coordinates) {
    options.check?.(); coordinates.set(coordinate.factKey, coordinate);
    if (!['number', 'boolean', 'text', 'date'].includes(coordinate.dataType)) issue('TYPE_MISMATCH', 'El tipo de la coordenada no está admitido.', coordinate.sourceLocator);
    if (coordinate.dataType === 'text' || coordinate.dataType === 'date') {
      if (v1) issue('PROFILE_MISMATCH', 'El perfil v1 no admite coordenadas de texto o fecha.', coordinate.sourceLocator);
      if (coordinate.unit !== '' || coordinate.decimals !== '') issue('TYPE_MISMATCH', 'Texto y fecha requieren unidad y precisión vacías.', coordinate.sourceLocator);
    }
  }
  for (const fact of content.facts) {
    options.check?.(); const value = fact.normalizedValue, coordinate = coordinates.get(fact.factKey);
    const tagged = typeof value === 'object' && value !== null && 'kind' in value;
    if (v1 && tagged) issue('PROFILE_MISMATCH', 'El perfil v1 no admite valores tipados de texto o fecha.', fact.sourceLocator);
    if (fact.presence === 'null') {
      if (value !== undefined) issue('TYPE_MISMATCH', 'Un dato nulo no contiene un valor normalizado.', fact.sourceLocator);
      continue;
    }
    if (fact.presence !== 'value' || value === undefined) { issue('TYPE_MISMATCH', 'Un dato informado necesita un valor normalizado.', fact.sourceLocator); continue; }
    if (tagged) {
      if (value.kind === 'text') {
        if (typeof value.value !== 'string' || value.value.length > 32_767) issue('TYPE_MISMATCH', 'El texto informado no tiene el formato admitido.', fact.sourceLocator);
      } else if (value.kind === 'date') {
        if (typeof value.value !== 'string' || !isCivilDateV2(value.value)) issue('INVALID_DATE', 'La fecha civil no es válida entre 0001 y 9999.', fact.sourceLocator);
      } else issue('TYPE_MISMATCH', 'El tipo del valor normalizado no está admitido.', fact.sourceLocator);
    } else if (!isRationalValue(value) && typeof value !== 'boolean') issue('TYPE_MISMATCH', 'El valor normalizado no tiene el formato admitido.', fact.sourceLocator);
    if (coordinate) {
      const matches = coordinate.dataType === 'number' ? isRationalValue(value) : coordinate.dataType === 'boolean' ? typeof value === 'boolean'
        : tagged && value.kind === coordinate.dataType;
      if (!matches) issue('TYPE_MISMATCH', 'El valor informado no corresponde al tipo de su coordenada.', fact.sourceLocator);
    }
  }
  return diagnostics;
}
