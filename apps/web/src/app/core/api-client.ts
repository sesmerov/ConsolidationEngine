import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import type { HttpResponse } from '@angular/common/http';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';
import type { BootstrapDTO, CapabilitiesDTO, DirectionChoiceDTO, DirectionsResponseDTO, JobDTO, RulesPageDTO, WorkspaceDTO, ValidationResultsPageDTO } from '@ce/contracts';
import type { HistoryPageDTO, PreviewDTO, PreviewSelectionDTO, PreviewSummaryDTO, ProposalDTO, ProposalsPageDTO, RunSummaryDTO } from '@ce/contracts';
import type { ApplicationDetailDTO, ApplicationRequestDTO, ComparisonPageDTO } from '@ce/contracts';
import type { ActiveImportInspectionDTO, ImportContextInputDTO, ImportInspectionCommitDTO, ImportInspectionDTO } from '@ce/contracts';
import type { VersionExportSummaryDTO } from '@ce/contracts';
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
  capabilities(): Promise<CapabilitiesDTO> { return firstValueFrom(this.http.get<CapabilitiesDTO>('/api/v1/capabilities', { headers: this.headers() })); }
  reportTemplate(): Promise<Blob> { return firstValueFrom(this.http.get('/api/v1/templates/report', { headers: this.headers(), responseType: 'blob' })); }
  corepTemplate(): Promise<Blob> { return firstValueFrom(this.http.get('/api/v1/templates/corep-ca1', { headers: this.headers(), responseType: 'blob' })); }
  visualDemo(kind: 'corep' | 'types', artifact: 'catalog' | 'report'): Promise<Blob> { return firstValueFrom(this.http.get(`/api/v1/templates/demos/${kind}/${artifact}`, { headers: this.headers(), responseType: 'blob' })); }
  activeImportInspection(workspaceId: string): Promise<ActiveImportInspectionDTO> { return firstValueFrom(this.http.get<ActiveImportInspectionDTO>(this.inspectionsUrl(workspaceId), { headers: this.headers() })); }
  importInspection(workspaceId: string, id: string): Promise<ImportInspectionDTO> { return firstValueFrom(this.http.get<ImportInspectionDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id), { headers: this.headers() })); }
  inspectImport(workspaceId: string, etag: string, catalog: File, reports: readonly File[], context: ImportContextInputDTO, key: string, signal: AbortSignal): Promise<JobDTO> {
    const body = new FormData(); body.append('catalog', catalog, catalog.name); for (const report of reports) body.append('reports', report, report.name); body.append('context', JSON.stringify(context));
    return firstValueFrom(this.http.post<JobDTO>(this.inspectionsUrl(workspaceId), body, { headers: this.headers(etag).set('Idempotency-Key', key) }).pipe(takeUntil(fromEvent(signal, 'abort'))));
  }
  commitImportInspection(workspaceId: string, id: string, body: ImportInspectionCommitDTO, etag: string, key: string): Promise<JobDTO> { return firstValueFrom(this.http.post<JobDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id) + '/commit', body, { headers: this.headers(etag).set('Idempotency-Key', key) })); }
  discardImportInspection(workspaceId: string, id: string, etag: string): Promise<ImportInspectionDTO> { return firstValueFrom(this.http.delete<ImportInspectionDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id), { headers: this.headers(etag) })); }
  private inspectionsUrl(workspaceId: string): string { return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/import-inspections'; }
  guidedExample(kind: 'catalog' | 'report'): Promise<Blob> { return firstValueFrom(this.http.get('/api/v1/templates/guided-' + kind, { headers: this.headers(), responseType: 'blob' })); }
  importFiles(workspaceId: string, etag: string, catalog: File, reports: readonly File[], key: string, signal: AbortSignal): Promise<JobDTO> {
    const body = new FormData(); body.append('catalog', catalog, catalog.name); for (const report of reports) body.append('reports', report, report.name);
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/imports', body,
      { headers: this.headers(etag).set('Idempotency-Key', key) }).pipe(takeUntil(fromEvent(signal, 'abort'))));
  }
  rules(workspaceId: string, versionId: string, filters: { code?: string; status?: string; cursor?: string } = {}): Promise<RulesPageDTO> {
    return firstValueFrom(this.http.get<RulesPageDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/rules',
      { headers: this.headers(), params: { versionId, limit: '50', ...filters } }));
  }
  validate(workspaceId: string, baseVersionId: string, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/validations', { baseVersionId }, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  results(workspaceId: string, runId: string, filters: { code?: string; status?: string; table?: string; cursor?: string } = {}): Promise<ValidationResultsPageDTO> {
    return firstValueFrom(this.http.get<ValidationResultsPageDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/runs/' + encodeURIComponent(runId) + '/results', { headers: this.headers(), params: { limit: '50', ...filters } }));
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
  proposal(workspaceId: string, previewId: string, proposalId: string): Promise<ProposalDTO> { return firstValueFrom(this.http.get<ProposalDTO>(this.previewUrl(workspaceId, previewId) + '/proposals/' + encodeURIComponent(proposalId), { headers: this.headers() })); }
  proposals(workspaceId: string, previewId: string, filters: { status?: string; code?: string; table?: string; cursor?: string } = {}): Promise<ProposalsPageDTO> {
    return firstValueFrom(this.http.get<ProposalsPageDTO>(this.previewUrl(workspaceId, previewId) + '/proposals', { headers: this.headers(), params: { limit: '50', ...filters } }));
  }
  previewSelection(workspaceId: string, previewId: string, selectedIds: readonly string[]): Promise<PreviewSelectionDTO> {
    return firstValueFrom(this.http.post<PreviewSelectionDTO>(this.previewUrl(workspaceId, previewId) + '/selection', { selectedIds }, { headers: this.headers() }));
  }
  discardPreview(workspaceId: string, previewId: string, etag: string): Promise<PreviewDTO> { return firstValueFrom(this.http.delete<PreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers(etag) })); }
  apply(workspaceId: string, body: ApplicationRequestDTO, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/applications', body, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  application(workspaceId: string, receiptId: string): Promise<ApplicationDetailDTO> {
    return firstValueFrom(this.http.get<ApplicationDetailDTO>(this.applicationUrl(workspaceId, receiptId), { headers: this.headers() }));
  }
  comparison(workspaceId: string, receiptId: string, filters: { cursor?: string; changedOnly?: boolean } = {}): Promise<ComparisonPageDTO> {
    return firstValueFrom(this.http.get<ComparisonPageDTO>(this.applicationUrl(workspaceId, receiptId) + '/comparison', { headers: this.headers(), params: { limit: '50', ...(filters.cursor ? { cursor: filters.cursor } : {}), ...(filters.changedOnly === undefined ? {} : { changedOnly: String(filters.changedOnly) }) } }));
  }
  private applicationUrl(workspaceId: string, receiptId: string): string { return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/applications/' + encodeURIComponent(receiptId); }
  private previewUrl(workspaceId: string, previewId: string): string { return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/previews/' + encodeURIComponent(previewId); }
  exportResults(workspaceId: string, versionId: string, runId: string, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/exports', { versionId, runId, kind: 'results' }, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  exportSummary(workspaceId: string, versionId: string): Promise<VersionExportSummaryDTO> {
    return firstValueFrom(this.http.get<VersionExportSummaryDTO>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/versions/${encodeURIComponent(versionId)}/export-summary`, { headers: this.headers() }));
  }
  exportReport(workspaceId: string, versionId: string, etag: string, key: string): Promise<JobDTO> {
    return firstValueFrom(this.http.post<JobDTO>('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/exports', { versionId, kind: 'report' }, { headers: this.headers(etag).set('Idempotency-Key', key) }));
  }
  downloadExport(workspaceId: string, exportId: string): Promise<Blob> {
    return firstValueFrom(this.http.get('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/exports/' + encodeURIComponent(exportId), { headers: this.headers(), responseType: 'blob' }));
  }
  private jobUrl(workspaceId: string, jobId: string): string {
    return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/jobs/' + encodeURIComponent(jobId);
  }
}
