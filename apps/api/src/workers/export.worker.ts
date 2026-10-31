import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { writeResultsExport } from '../export/results-export.js';
import type { ExportLimits, ExportPaths, ResultsExportData } from '../export/results-export.js';
import type { OperationContext, WorkerOutput } from './protocol.js';
export interface ExportInput { readonly exportId: string; readonly fileId: string; readonly data: ResultsExportData; readonly paths: ExportPaths; readonly limits: ExportLimits }
export const exportKey = (workspaceId: string, exportId: string) => 'export:' + workspaceId + ':' + exportId;
export interface ExportArtifact { readonly id: string; readonly jobId: string; readonly workspaceId: string; readonly versionId: string; readonly runId: string; readonly fileId: string; readonly size: number; readonly sha256: string; readonly filename: string; readonly mimeType: string }
export async function execute(input: JsonValue, context: OperationContext): Promise<WorkerOutput> {
  const request = input as unknown as ExportInput; if (!request || !request.data || !request.paths || context.snapshot) throw new ApiError('INTERNAL_ERROR');
  const output = await writeResultsExport(request.data, request.paths, request.limits, () => { if (context.cancelled()) throw new ApiError('INTERNAL_ERROR'); }, context.progress);
  const artifact: ExportArtifact = { id: request.exportId, jobId: context.job.jobId, workspaceId: context.job.workspaceId, versionId: request.data.versionId, runId: request.data.run.id,
    fileId: request.fileId, ...output, filename: 'results.zip', mimeType: 'application/zip' };
  return { complete: true, resultRef: { type: 'export', id: artifact.id }, records: [{ key: exportKey(artifact.workspaceId, artifact.id), value: artifact as unknown as JsonValue }] };
}
