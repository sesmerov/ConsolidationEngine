import type { Coordinate, Diagnostic, SourceLocator } from '@ce/contracts';
import type { ExactRational } from '../numeric/rational.js';
import type { UnitMap } from '../numeric/units.js';

type Provenance = { readonly coordinate?: Coordinate; readonly sourceLocator?: SourceLocator };
export type NumericScalar = Provenance & {
  readonly kind: 'number'; readonly nominal: ExactRational; readonly lo: ExactRational; readonly hi: ExactRational;
  readonly unit: UnitMap;
  /** True only while this pure numeric literal has not adopted a coordinate's unit. */
  readonly literal?: boolean;
};
export type BooleanScalar = Provenance & { readonly kind: 'boolean'; readonly value: boolean };
export type NullScalar = Provenance & { readonly kind: 'null'; readonly origin: 'explicit' | 'implicit' | 'derived' } & (
  | { readonly dataType: 'number'; readonly unit: UnitMap }
  | { readonly dataType: 'boolean' }
);
/** Missing metadata is not a missing fact. Its trace is collected independently by the evaluator. */
export type UnknownScalar = { readonly kind: 'unknown'; readonly dataType?: 'number' | 'boolean' };
export type ScalarValue = NumericScalar | BooleanScalar | NullScalar | UnknownScalar;
export type ValueErrorCode = 'TYPE_MISMATCH' | 'UNIT_MISMATCH' | 'INVALID_UNIT';
export class ValueError extends Error {
  constructor(readonly code: ValueErrorCode, message: string = code) { super(message); }
}
export type PrimitiveResult = { readonly value: ScalarValue; readonly diagnostics: readonly Diagnostic[] };
