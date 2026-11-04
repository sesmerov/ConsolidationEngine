import { LANGUAGE_PROFILE_V1, LANGUAGE_PROFILE_V2, validateProfileValues } from '@ce/contracts';
import type { Diagnostic, Snapshot } from '@ce/contracts';
import type { WorkBudget } from '../execution/budget.js';

export interface LanguageProfile {
  readonly id: typeof LANGUAGE_PROFILE_V1 | typeof LANGUAGE_PROFILE_V2;
  readonly booleanRecalculation: boolean;
  /** Capabilities are explicit; later additions must be accompanied by evaluator tests. */
  readonly constructs: readonly string[];
}
const profiles: Readonly<Record<string, LanguageProfile>> = Object.freeze({
  [LANGUAGE_PROFILE_V1]: Object.freeze({ id: LANGUAGE_PROFILE_V1, booleanRecalculation: true, constructs: Object.freeze(['number', 'boolean', 'reference', 'arithmetic', 'comparison', 'isnull', 'nvl', 'sum']) }),
  [LANGUAGE_PROFILE_V2]: Object.freeze({ id: LANGUAGE_PROFILE_V2, booleanRecalculation: false, constructs: Object.freeze(['number', 'boolean', 'text', 'date', 'if', 'reference', 'arithmetic', 'comparison', 'isnull', 'nvl', 'sum']) }),
});
export function languageProfile(profileId: string): LanguageProfile | undefined { return Object.hasOwn(profiles, profileId) ? profiles[profileId] : undefined; }
export class ProfileError extends Error {
  readonly code = 'PROFILE_MISMATCH';
  constructor(message: string, readonly diagnostics: readonly Diagnostic[] = []) { super(message); }
}
// An operation owns its budget; no cached decision crosses a profile/content identity.
const checks = new WeakMap<WorkBudget, WeakMap<Snapshot['content'], readonly Diagnostic[]>>();
export function snapshotProfileDiagnostics(snapshot: Snapshot, budget?: WorkBudget): readonly Diagnostic[] {
  budget?.check();
  let contents = budget ? checks.get(budget) : undefined;
  if (budget && !contents) { contents = new WeakMap(); checks.set(budget, contents); }
  const cached = contents?.get(snapshot.content); if (cached) return cached;
  const diagnostics = validateProfileValues(snapshot.content, { ...(budget ? { check: () => budget.check() } : {}) });
  contents?.set(snapshot.content, diagnostics); return diagnostics;
}
export function assertSnapshotProfile(snapshot: Snapshot, budget?: WorkBudget): LanguageProfile {
  const profile = languageProfile(snapshot.content.profileId);
  if (!profile) throw new ProfileError('El perfil del snapshot no está admitido.');
  const diagnostics = snapshotProfileDiagnostics(snapshot, budget);
  if (diagnostics.length) throw new ProfileError('Los datos no pertenecen al perfil declarado.', diagnostics);
  return profile;
}
