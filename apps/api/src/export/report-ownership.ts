import { LANGUAGE_PROFILE_V1, LANGUAGE_PROFILE_V2, REPORT_SHEETS } from '@ce/contracts';
import type { ReportSourceBinding, Snapshot, VersionExportSummaryDTO } from '@ce/contracts';
import { COREP_MAPPING_SHA256, COREP_PROFILE_ID } from '../import/profiles/corep-ca1.js';
import { DEMO_TYPES_MAPPING, DEMO_TYPES_MAPPING_SHA256, DEMO_TYPES_PROFILE_ID } from '../import/profiles/demo-types.js';
import { unavailable, sourceSignature } from './change-log.js';

/** Bindings are persisted import authority; a manual context never acquires a fabricated locator. */
export function reportOwnership(snapshot: Snapshot, check: () => void = () => {}) {
  const content = snapshot.content; sourceSignature(content.sources);
  const reports = content.sources.filter(source => source.kind === 'report'), sources = new Set(reports.map(source => source.id));
  const bindings = new Map<string, ReportSourceBinding>(), owners = new Map<string, string>();
  if (content.profileId === LANGUAGE_PROFILE_V2) {
    if (content.reportSourceBindings?.length !== reports.length) return unavailable('INVALID_REPORT_SOURCE');
    for (const binding of content.reportSourceBindings) {
      check(); const expected = binding.profileId === COREP_PROFILE_ID ? [COREP_MAPPING_SHA256, 'CA1'] : binding.profileId === DEMO_TYPES_PROFILE_ID ? [DEMO_TYPES_MAPPING_SHA256, DEMO_TYPES_MAPPING.sheet] : undefined;
      if (!expected || !sources.has(binding.sourceFileId) || bindings.has(binding.sourceFileId) || binding.mappingSha256 !== expected[0]
        || binding.contextIds.length !== 1 || binding.selectedSheets.length !== 1 || binding.selectedSheets[0] !== expected[1]
        || binding.excludedSheets.length > 256 || new Set(binding.excludedSheets).size !== binding.excludedSheets.length
        || binding.excludedSheets.some(name => !name.length || name.length > 31 || binding.selectedSheets.includes(name))
        || !['form', 'workbook'].includes(binding.contextOrigin)) return unavailable('INVALID_REPORT_SOURCE');
      bindings.set(binding.sourceFileId, binding);
      for (const contextId of binding.contextIds) { check(); if (owners.has(contextId)) return unavailable('INVALID_REPORT_SOURCE'); owners.set(contextId, binding.sourceFileId); }
    }
  } else if (content.profileId !== LANGUAGE_PROFILE_V1 || content.reportSourceBindings?.length) return unavailable('INVALID_REPORT_SOURCE');
  const seen = new Set<string>(), counts = new Map<string, number>();
  for (const context of content.contexts) {
    check(); const fileId = content.profileId === LANGUAGE_PROFILE_V2 ? owners.get(context.contextId) : context.filingIndicatorsLocator?.fileId;
    if (!fileId || !sources.has(fileId) || seen.has(context.contextId) || (context.filingIndicatorsLocator?.fileId && context.filingIndicatorsLocator.fileId !== fileId)) return unavailable('INVALID_REPORT_SOURCE');
    seen.add(context.contextId); owners.set(context.contextId, fileId); counts.set(fileId, (counts.get(fileId) ?? 0) + 1);
    if (counts.get(fileId)! > 200_000) return unavailable('INVALID_REPORT_SOURCE');
  }
  if (seen.size !== owners.size || reports.some(source => !counts.has(source.id))) return unavailable('INVALID_REPORT_SOURCE');
  return { reports, bindings, owners };
}
export function versionExportSummary(snapshot: Snapshot, check: () => void): VersionExportSummaryDTO {
  const { reports, bindings, owners } = reportOwnership(snapshot, check);
  const aggregates = new Map<string, { count: number; entityId: string | undefined; referenceDate: string | undefined }>();
  for (const context of snapshot.content.contexts) {
    check(); const owner = owners.get(context.contextId)!, prior = aggregates.get(owner);
    aggregates.set(owner, prior ? { count: prior.count + 1, entityId: prior.entityId === context.entityId ? prior.entityId : undefined,
      referenceDate: prior.referenceDate === context.referenceDate ? prior.referenceDate : undefined } : { count: 1, entityId: context.entityId, referenceDate: context.referenceDate });
  }
  return { versionId: snapshot.versionId, profileId: snapshot.content.profileId, createdAt: snapshot.createdAt,
    reports: reports.map(source => { check(); const binding = bindings.get(source.id), aggregate = aggregates.get(source.id)!;
      return { sourceFileId: source.id, displayName: source.displayName, profileId: binding?.profileId ?? 'ce-report-1', contextCount: aggregate.count,
        ...(aggregate.entityId !== undefined ? { commonEntityId: aggregate.entityId } : {}), ...(aggregate.referenceDate !== undefined ? { commonReferenceDate: aggregate.referenceDate } : {}),
        contextOrigin: binding?.contextOrigin ?? 'workbook', selectedSheets: binding?.selectedSheets ?? REPORT_SHEETS, excludedSheets: binding?.excludedSheets ?? [],
        ...(binding?.scaleExponent !== undefined ? { scaleExponent: binding.scaleExponent } : {}), ...(binding?.displayDecimals !== undefined ? { displayDecimals: binding.displayDecimals } : {}) };
    }) };
}
