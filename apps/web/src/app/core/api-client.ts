import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import type { HttpResponse } from '@angular/common/http';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';
import type { BootstrapDTO, CapabilitiesDTO, DirectionChoiceDTO, DirectionsResponseDTO, JobDTO, RulesPageDTO, WorkspaceDTO, ValidationResultsPageDTO } from '@ce/contracts';
import type { HistoryPageDTO, PreviewDTO, PreviewSelectionDTO, PreviewSummaryDTO, ProposalDTO, ProposalsPageDTO, RunSummaryDTO } from '@ce/contracts';
import type { ApplicationDetailDTO, ApplicationRequestDTO, ComparisonPageDTO } from '@ce/contracts';
import type { ActiveImportInspectionDTO, ImportContextInputDTO, ImportInspectionCommitDTO, ImportInspectionDTO } from '@ce/contracts';
import type { ExportArtifactSummaryDTO, VersionExportSummaryDTO } from '@ce/contracts';
import type { OperationReceiptDTO, RecalculationStateDTO, RecalculationOperationRequestDTO, RecalculationOperationAcceptedDTO } from '@ce/contracts';
import type {
  DirectionConflictGroupsPageDTO, DirectionConflictCandidatesPageDTO, DirectionConflictCandidateDetailDTO,
  ProposalSelectionSummaryDTO, ProposalSelectionEditDTO, ProposalSelectionRowsQueryDTO, ProposalSelectionPageDTO,
  ProposalDependencyPageDTO, ProposalExplanationDTO, ProposalExplanationPageDTO, ProposalExplanationSection,
  CompactApplicationDetailDTO, CompactComparisonPageDTO, CompactPreviewDTO,
} from '@ce/contracts';
import type {
  DirectionReviewActiveDTO, DirectionReviewCommitDTO, DirectionReviewDecision, DirectionReviewMutationResponseDTO,
  DirectionReviewPageDTO, DirectionReviewPatchDTO, DirectionReviewPrepareDTO, DirectionReviewSummaryDTO,
} from '@ce/contracts';
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private token: string | undefined;
  setSessionToken(token: string): void { this.token = token; }
  clearSession(): void { this.token = undefined; }
  private headers(etag?: string): HttpHeaders {
    let headers = new HttpHeaders();
    if (this.token) headers = headers.set('X-CE-Session', this.token);
    if (etag) headers = headers.set('If-Match', etag);
    return headers;
  }
  bootstrap(): Promise<BootstrapDTO> { return firstValueFrom(this.http.get<BootstrapDTO>('/api/v1/bootstrap')); }
  createWorkspace(name: string): Promise<HttpResponse<WorkspaceDTO>> {
    return firstValueFrom(this.http.post<WorkspaceDTO>('/api/v1/workspaces', { name }, { headers: this.headers(), observe: 'response' }));
  }
  workspace(id: string): Promise<HttpResponse<WorkspaceDTO>> {
    return firstValueFrom(this.http.get<WorkspaceDTO>('/api/v1/workspaces/' + encodeURIComponent(id), { headers: this.headers(), observe: 'response' }));
  }
  closeWorkspace(id: string, etag: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>('/api/v1/workspaces/' + encodeURIComponent(id), { headers: this.headers(etag) }));
  }
  job(workspaceId: string, jobId: string): Promise<JobDTO> {
    return firstValueFrom(this.http.get<JobDTO>(this.jobUrl(workspaceId, jobId), { headers: this.headers() }));
  }
  cancelJob(workspaceId: string, jobId: string): Promise<JobDTO> {
    return firstValueFrom(this.http.delete<JobDTO>(this.jobUrl(workspaceId, jobId), { headers: this.headers() }));
  }
  operation(id: string): Promise<OperationReceiptDTO> { return firstValueFrom(this.http.get<OperationReceiptDTO>('/api/v1/operations/' + encodeURIComponent(id), { headers: this.headers() })); }
  operationReceipt(key: string): Promise<OperationReceiptDTO> { return firstValueFrom(this.http.get<OperationReceiptDTO>('/api/v1/operation-receipts/' + encodeURIComponent(key), { headers: this.headers() })); }
  recalculationState(workspaceId: string): Promise<RecalculationStateDTO> {
    return firstValueFrom(this.http.get<RecalculationStateDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/recalculation-state', { headers: this.headers() }));
  }
  recalculate(workspaceId: string, body: RecalculationOperationRequestDTO, etag: string, key: string): Promise<RecalculationOperationAcceptedDTO> {
    return firstValueFrom(this.http.post<RecalculationOperationAcceptedDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/recalculation-operations', body, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  capabilities(): Promise<CapabilitiesDTO> { return firstValueFrom(this.http.get<CapabilitiesDTO>('/api/v1/capabilities', { headers: this.headers() })); }
  corepTemplate(): Promise<Blob> { return firstValueFrom(this.http.get('/api/v1/templates/corep-ca1', { headers: this.headers(), responseType: 'blob' })); }
  visualDemo(kind: 'corep' | 'types' | 'finrep', artifact: 'catalog' | 'report'): Promise<Blob> { return firstValueFrom(this.http.get(`/api/v1/templates/demos/${kind}/${artifact}`, { headers: this.headers(), responseType: 'blob' })); }
  activeImportInspection(workspaceId: string): Promise<ActiveImportInspectionDTO> { return firstValueFrom(this.http.get<ActiveImportInspectionDTO>(this.inspectionsUrl(workspaceId), { headers: this.headers() })); }
  importInspection(workspaceId: string, id: string): Promise<ImportInspectionDTO> { return firstValueFrom(this.http.get<ImportInspectionDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id), { headers: this.headers() })); }
  inspectImport(workspaceId: string, etag: string, catalog: File, reports: readonly File[], context: ImportContextInputDTO, key: string, signal: AbortSignal): Promise<JobDTO> {
    const body = new FormData(); body.append('catalog', catalog, catalog.name); for (const report of reports) body.append('reports', report, report.name); body.append('context', JSON.stringify(context));
    return firstValueFrom(this.http.post<JobDTO>(this.inspectionsUrl(workspaceId), body, { headers: this.headers(etag).set('Idempotency-Key', key) }).pipe(takeUntil(fromEvent(signal, 'abort'))));
  }
  commitImportInspection(workspaceId: string, id: string, body: ImportInspectionCommitDTO, etag: string, key: string): Promise<JobDTO> { return firstValueFrom(this.http.post<JobDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id) + '/commit', body, { headers: this.headers(etag).set('Idempotency-Key', key) })); }
  discardImportInspection(workspaceId: string, id: string, etag: string): Promise<ImportInspectionDTO> { return firstValueFrom(this.http.delete<ImportInspectionDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id), { headers: this.headers(etag) })); }
  private inspectionsUrl(workspaceId: string): string { return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/import-inspections'; }
  rules(workspaceId: string, versionId: string, filters: { code?: string; status?: string; table?: string; cursor?: string } = {}): Promise<RulesPageDTO> {
    return firstValueFrom(this.http.get<RulesPageDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/rules',
      { headers: this.headers(), params: { versionId, limit: '50', ...filters } }));
  }
  validate(workspaceId: string, baseVersionId: string, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/validations', { baseVersionId }, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  results(workspaceId: string, runId: string, filters: { code?: string; status?: string; table?: string; cursor?: string; includeConfiguredDirections?: boolean } = {}): Promise<ValidationResultsPageDTO> {
    return firstValueFrom(this.http.get<ValidationResultsPageDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/runs/' + encodeURIComponent(runId) + '/results', { headers: this.headers(), params: { limit: '50', ...filters } }));
  }
  private reviewsUrl(workspaceId: string, reviewId?: string): string {
    const collection = '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/recalculation-reviews';
    return reviewId ? collection + '/' + encodeURIComponent(reviewId) : collection;
  }
  activeDirectionReviews(workspaceId: string): Promise<DirectionReviewActiveDTO> {
    return firstValueFrom(this.http.get<DirectionReviewActiveDTO>(this.reviewsUrl(workspaceId), { headers: this.headers() }));
  }
  directionReview(workspaceId: string, id: string): Promise<DirectionReviewSummaryDTO> {
    return firstValueFrom(this.http.get<DirectionReviewSummaryDTO>(this.reviewsUrl(workspaceId, id), { headers: this.headers() }));
  }
  directionReviewRows(workspaceId: string, id: string, filters: { cursor?: string; groupId?: string; state?: DirectionReviewDecision; scope?: 'pending'|'resolved'|'all' }): Promise<DirectionReviewPageDTO> {
    return firstValueFrom(this.http.get<DirectionReviewPageDTO>(this.reviewsUrl(workspaceId, id) + '/rows', { headers:this.headers(), params:{limit:'50',...filters} }));
  }
  directionConflictGroups(workspaceId: string, id: string, query: { cursor?: string; scope?: 'pending'|'resolved'|'all' } = {}): Promise<DirectionConflictGroupsPageDTO> {
    return firstValueFrom(this.http.get<DirectionConflictGroupsPageDTO>(this.reviewsUrl(workspaceId, id) + '/groups', { headers: this.headers(), params: { limit: '50', ...query } }));
  }
  directionConflictCandidates(workspaceId: string, id: string, groupId: string, query: { cursor?: string } = {}): Promise<DirectionConflictCandidatesPageDTO> {
    return firstValueFrom(this.http.get<DirectionConflictCandidatesPageDTO>(this.reviewsUrl(workspaceId, id) + '/groups/' + encodeURIComponent(groupId) + '/candidates', { headers: this.headers(), params: { limit: '50', ...query } }));
  }
  directionConflictCandidate(workspaceId: string, id: string, groupId: string, instanceId: string): Promise<DirectionConflictCandidateDetailDTO> {
    return firstValueFrom(this.http.get<DirectionConflictCandidateDetailDTO>(this.reviewsUrl(workspaceId, id) + '/groups/' + encodeURIComponent(groupId) + '/candidates/' + encodeURIComponent(instanceId), { headers: this.headers() }));
  }
  prepareDirectionReview(workspaceId: string, body: DirectionReviewPrepareDTO, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>(this.reviewsUrl(workspaceId), body, {headers:this.headers(etag).set('Idempotency-Key',key)}));
  }
  editDirectionReview(workspaceId: string, id: string, body: DirectionReviewPatchDTO, etag: string): Promise<DirectionReviewMutationResponseDTO> {
    return firstValueFrom(this.http.patch<DirectionReviewMutationResponseDTO>(this.reviewsUrl(workspaceId,id), body, {headers:this.headers(etag)}));
  }
  commitDirectionReview(workspaceId: string, id: string, body: DirectionReviewCommitDTO, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>(this.reviewsUrl(workspaceId,id) + '/commit', body, {headers:this.headers(etag).set('Idempotency-Key',key)}));
  }
  discardDirectionReview(workspaceId: string, id: string, etag: string): Promise<DirectionReviewSummaryDTO> {
    return firstValueFrom(this.http.delete<DirectionReviewSummaryDTO>(this.reviewsUrl(workspaceId,id), {headers:this.headers(etag)}));
  }
  replaceDirections(workspaceId: string, directions: readonly DirectionChoiceDTO[], etag: string): Promise<HttpResponse<DirectionsResponseDTO>> {
    return firstValueFrom(this.http.put<DirectionsResponseDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/directions', { directions }, { headers: this.headers(etag), observe: 'response' }));
  }
  runs(workspaceId: string, cursor?: string): Promise<HistoryPageDTO<RunSummaryDTO>> {
    return firstValueFrom(this.http.get<HistoryPageDTO<RunSummaryDTO>>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/runs', { headers: this.headers(), params: { limit: '50', ...(cursor ? { cursor } : {}) } }));
  }
  previews(workspaceId: string, cursor?: string): Promise<HistoryPageDTO<PreviewSummaryDTO>> {
    return firstValueFrom(this.http.get<HistoryPageDTO<PreviewSummaryDTO>>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/previews', { headers: this.headers(), params: { limit: '50', ...(cursor ? { cursor } : {}) } }));
  }
  createPreview(workspaceId: string, baseVersionId: string, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/previews', { baseVersionId }, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  preview(workspaceId: string, previewId: string): Promise<PreviewDTO> { return firstValueFrom(this.http.get<PreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers() })); }
  previewCompact(workspaceId: string, previewId: string): Promise<CompactPreviewDTO> { return firstValueFrom(this.http.get<CompactPreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers(), params: { compact: 'true' } })); }
  proposal(workspaceId: string, previewId: string, proposalId: string): Promise<ProposalDTO> { return firstValueFrom(this.http.get<ProposalDTO>(this.previewUrl(workspaceId, previewId) + '/proposals/' + encodeURIComponent(proposalId), { headers: this.headers() })); }
  proposals(workspaceId: string, previewId: string, filters: { status?: string; code?: string; table?: string; contextId?: string; cursor?: string } = {}): Promise<ProposalsPageDTO> {
    return firstValueFrom(this.http.get<ProposalsPageDTO>(this.previewUrl(workspaceId, previewId) + '/proposals', { headers: this.headers(), params: { limit: '50', ...filters } }));
  }
  previewSelection(workspaceId: string, previewId: string, selectedIds: readonly string[]): Promise<PreviewSelectionDTO> {
    return firstValueFrom(this.http.post<PreviewSelectionDTO>(this.previewUrl(workspaceId, previewId) + '/selection', { selectedIds }, { headers: this.headers() }));
  }
  proposalSelectionState(workspaceId: string, previewId: string): Promise<ProposalSelectionSummaryDTO> {
    return firstValueFrom(this.http.get<ProposalSelectionSummaryDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state', { headers: this.headers() }));
  }
  prepareProposalSelection(workspaceId: string, previewId: string, baseVersionId: string, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state', { baseVersionId, seed: 'empty' }, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  editProposalSelection(workspaceId: string, previewId: string, body: ProposalSelectionEditDTO, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state/edits', body, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  selectionRows(workspaceId: string, previewId: string, query: ProposalSelectionRowsQueryDTO = {}): Promise<ProposalSelectionPageDTO> {
    return firstValueFrom(this.http.get<ProposalSelectionPageDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state/rows', { headers: this.headers(), params: { limit: '50', ...query } }));
  }
  selectionDependencies(workspaceId: string, previewId: string, proposalId: string, query: { scope?: 'all' | 'missing'; cursor?: string } = {}): Promise<ProposalDependencyPageDTO> {
    return firstValueFrom(this.http.get<ProposalDependencyPageDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state/proposals/' + encodeURIComponent(proposalId) + '/dependencies', { headers: this.headers(), params: { limit: '50', ...query } }));
  }
  proposalExplanation(workspaceId: string, previewId: string, proposalId: string): Promise<ProposalExplanationDTO> {
    return firstValueFrom(this.http.get<ProposalExplanationDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state/proposals/' + encodeURIComponent(proposalId) + '/explanation', { headers: this.headers() }));
  }
  proposalExplanationItems(workspaceId: string, previewId: string, proposalId: string, query: { section: ProposalExplanationSection; cursor?: string }): Promise<ProposalExplanationPageDTO> {
    return firstValueFrom(this.http.get<ProposalExplanationPageDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state/proposals/' + encodeURIComponent(proposalId) + '/explanation/items', { headers: this.headers(), params: { limit: '50', ...query } }));
  }
  discardPreview(workspaceId: string, previewId: string, etag: string): Promise<PreviewDTO> { return firstValueFrom(this.http.delete<PreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers(etag) })); }
  discardPreviewCompact(workspaceId: string, previewId: string, etag: string): Promise<CompactPreviewDTO> { return firstValueFrom(this.http.delete<CompactPreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers(etag), params: { compact: 'true' } })); }
  apply(workspaceId: string, body: ApplicationRequestDTO, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/applications', body, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  application(workspaceId: string, receiptId: string): Promise<ApplicationDetailDTO> {
    return firstValueFrom(this.http.get<ApplicationDetailDTO>(this.applicationUrl(workspaceId, receiptId), { headers: this.headers() }));
  }
  applicationCompact(workspaceId: string, receiptId: string): Promise<CompactApplicationDetailDTO> {
    return firstValueFrom(this.http.get<CompactApplicationDetailDTO>(this.applicationUrl(workspaceId, receiptId), { headers: this.headers(), params: { includeAcceptedIds: 'false' } }));
  }
  comparisonCompact(workspaceId: string, receiptId: string, filters: { cursor?: string; changedOnly?: boolean } = {}): Promise<CompactComparisonPageDTO> {
    return firstValueFrom(this.http.get<CompactComparisonPageDTO>(this.applicationUrl(workspaceId, receiptId) + '/comparison', { headers: this.headers(), params: { limit: '50', includeAcceptedIds: 'false', ...(filters.cursor ? { cursor: filters.cursor } : {}), ...(filters.changedOnly === undefined ? {} : { changedOnly: String(filters.changedOnly) }) } }));
  }
  comparison(workspaceId: string, receiptId: string, filters: { cursor?: string; changedOnly?: boolean } = {}): Promise<ComparisonPageDTO> {
    return firstValueFrom(this.http.get<ComparisonPageDTO>(this.applicationUrl(workspaceId, receiptId) + '/comparison', { headers: this.headers(), params: { limit: '50', ...(filters.cursor ? { cursor: filters.cursor } : {}), ...(filters.changedOnly === undefined ? {} : { changedOnly: String(filters.changedOnly) }) } }));
  }
  private applicationUrl(workspaceId: string, receiptId: string): string { return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/applications/' + encodeURIComponent(receiptId); }
  private previewUrl(workspaceId: string, previewId: string): string { return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/previews/' + encodeURIComponent(previewId); }
  exportResults(workspaceId: string, versionId: string, runId: string, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/exports', { versionId, runId, kind: 'results' }, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  exportSummary(workspaceId: string, versionId: string, kind: 'report' | 'results' = 'report', runId?: string): Promise<VersionExportSummaryDTO> {
    const params = new HttpParams().set('kind', kind); const query = kind === 'results' && runId ? params.set('runId', runId) : params;
    return firstValueFrom(this.http.get<VersionExportSummaryDTO>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/versions/${encodeURIComponent(versionId)}/export-summary`, { headers: this.headers(), params: query }));
  }
  exportArtifactSummary(workspaceId: string, exportId: string): Promise<ExportArtifactSummaryDTO> {
    return firstValueFrom(this.http.get<ExportArtifactSummaryDTO>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/exports/${encodeURIComponent(exportId)}`, { headers: this.headers().set('Accept', 'application/json') }));
  }
  exportReport(workspaceId: string, versionId: string, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/exports', { versionId, kind: 'report' }, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  downloadExport(workspaceId: string, exportId: string, signal?: AbortSignal): Promise<Blob> {
    if (signal?.aborted) return Promise.reject(new DOMException('Descarga cancelada.', 'AbortError'));
    const request = this.http.get('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/exports/' + encodeURIComponent(exportId), { headers: this.headers().set('Accept', 'application/zip'), responseType: 'blob' });
    return firstValueFrom(signal ? request.pipe(takeUntil(fromEvent(signal, 'abort'))) : request);
  }
  private jobUrl(workspaceId: string, jobId: string): string {
    return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/jobs/' + encodeURIComponent(jobId);
  }
}
