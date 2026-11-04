import type { ReportSourceBinding } from '@ce/contracts';
/** One row per context or sheet keeps each cell bounded and avoids lossy joined lists. */
export function* bindingRows(bindings: readonly ReportSourceBinding[] | undefined): Generator<{ sheet: string; values: readonly string[] }> {
  if (!bindings) return;
  yield { sheet: 'ReportBindings', values: ['sourceFileId', 'profileId', 'mappingSha256', 'contextOrigin', 'scaleExponent', 'displayDecimals'] };
  yield { sheet: 'BindingContexts', values: ['sourceFileId', 'contextId'] };
  yield { sheet: 'BindingSheets', values: ['sourceFileId', 'status', 'sheet'] };
  for (const binding of bindings) {
    yield { sheet: 'ReportBindings', values: [binding.sourceFileId, binding.profileId, binding.mappingSha256, binding.contextOrigin, String(binding.scaleExponent ?? ''), String(binding.displayDecimals ?? '')] };
    for (const id of binding.contextIds) yield { sheet: 'BindingContexts', values: [binding.sourceFileId, id] };
    for (const name of binding.selectedSheets) yield { sheet: 'BindingSheets', values: [binding.sourceFileId, 'selected', name] };
    for (const name of binding.excludedSheets) yield { sheet: 'BindingSheets', values: [binding.sourceFileId, 'excluded', name] };
  }
}
