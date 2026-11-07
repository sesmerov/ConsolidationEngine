import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { writeResultsExport } from '../export/results-export.js';
import type { ExportLimits, ExportPaths, ResultsExportData } from '../export/results-export.js';
import { writeReportExport } from '../export/recalculated-report.js';
import type { ReportExportData, ReportExportLimits, ReportExportPaths } from '../export/recalculated-report.js';
import type { RetainedReportSource } from '../export/finrep-report.js';
import type { OperationContext, WorkerOutput } from './protocol.js';
export type ExportInput = { readonly exportId: string; readonly fileId: string } & (
  { readonly kind: 'results'; readonly data: ResultsExportData; readonly paths: ExportPaths; readonly limits: ExportLimits }
  | { readonly kind: 'report'; readonly data: ReportExportData; readonly paths: ReportExportPaths; readonly limits: ReportExportLimits;readonly originalReports?:readonly RetainedReportSource[] });
export const exportKey = (workspaceId: string, exportId: string) => 'export:' + workspaceId + ':' + exportId;
export interface ExportArtifact { readonly id: string; readonly jobId: string; readonly workspaceId: string; readonly versionId: string; readonly runId?: string; readonly fileId: string; readonly size: number; readonly sha256: string; readonly filename: 'results.zip' | 'report.zip'; readonly mimeType: string }
export async function execute(input: JsonValue, context: OperationContext): Promise<WorkerOutput> {
  const request = input as unknown as ExportInput; if (!request || !request.data || !request.paths || !['report', 'results'].includes(request.kind) || context.snapshot) throw new ApiError('INTERNAL_ERROR');
  const check = () => { if (context.cancelled()||context.job.deadline&&Date.now()>=Date.parse(context.job.deadline)) throw new ApiError('INTERNAL_ERROR'); };
  const output = request.kind === 'report' ? await writeReportExport(request.data, request.paths, request.limits, check, context.progress,request.originalReports)
    : await writeResultsExport(request.data, request.paths, request.limits, check, context.progress);
  const artifact: ExportArtifact = { id: request.exportId, jobId: context.job.jobId, workspaceId: context.job.workspaceId, versionId: request.data.versionId,
    ...(request.kind === 'results' ? { runId: request.data.run.id } : {}), fileId: request.fileId, ...output, filename: request.kind === 'report' ? 'report.zip' : 'results.zip', mimeType: 'application/zip' };
  return { complete: true, resultRef: { type: 'export', id: artifact.id }, records: [{ key: exportKey(artifact.workspaceId, artifact.id), value: artifact as unknown as JsonValue }] };
}
