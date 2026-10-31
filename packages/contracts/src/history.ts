import type { PreviewDTO } from './recalculation.js';
import type { ValidationRunDTO } from './validation.js';
export type RunSummaryDTO = Pick<ValidationRunDTO, 'id' | 'versionId' | 'profileId' | 'status' | 'startedAt' | 'endedAt'>;
export type PreviewSummaryDTO = Pick<PreviewDTO, 'id' | 'baseVersionId' | 'profileId' | 'policyId' | 'state' | 'createdAt'>;
export interface HistoryPageDTO<T> { readonly items: readonly T[]; readonly total: number; readonly nextCursor: string | null; readonly revision: string }
