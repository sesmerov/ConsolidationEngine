import type { ApplyChangeDTO,PublicApplicationChangeDTO,Snapshot } from '@ce/contracts';
/** A changed cell is shown once, independently of how many validation rows it affects. */
export function publicApplicationChange(snapshot:Snapshot,change:ApplyChangeDTO):PublicApplicationChangeDTO{
 const cell=change.before.coordinate,context=snapshot.content.contexts.find(row=>row.contextId===cell.contextId),value=change.before.normalizedValue;
 const before=change.before.originalText??(value===undefined?'Sin dato':typeof value==='boolean'?String(value):'kind' in value?value.value:value.denominator==='1'?value.numerator:`${value.numerator}/${value.denominator}`);
 return {itemId:change.proposalId,location:[cell.tableCode,cell.sheetCode,`r${cell.rowCode}`,`c${cell.columnCode}`,context?`${context.entityId} · ${context.referenceDate}`:cell.contextId].filter(Boolean).join(' · '),before,after:change.after.originalText,unit:cell.unit};
}
