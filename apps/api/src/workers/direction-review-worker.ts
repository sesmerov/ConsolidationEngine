import { DirectionReviewError, WorkBudget, WorkLimitError } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import { ApiError } from '../errors.js';
import type { OperationContext, WorkerOutput } from './protocol.js';

export function runDirectionWork(context: OperationContext, limits: Partial<WorkLimits> | undefined, run: (budget: WorkBudget) => WorkerOutput): WorkerOutput {
  const remaining = Math.max(0, Math.min(60_000, Date.parse(context.job.deadline!) - Date.now()));
  const budget = new WorkBudget({
    limits: { ...limits, milliseconds: Math.min(remaining, limits?.milliseconds ?? 60_000) },
    cancelled: context.cancelled,
  });
  try {
    budget.check();
    const output = run(budget);
    budget.check();
    return output;
  } catch (error) {
    if (error instanceof WorkLimitError) return { complete: false, diagnostics: [{ code: error.code, message: error.message }] };
    if (error instanceof DirectionReviewError) throw new ApiError('INVALID_DIRECTION', { reason: error.reason });
    throw error;
  }
}
