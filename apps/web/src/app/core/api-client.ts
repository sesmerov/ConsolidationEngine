import { CONNECTION_CONFIG } from './connection-config';
import { isLargeValue } from './public-value';
import type { PublicItemsPage, ResolvedItemsPage } from './public-value';
import type { PublicValue, PublicComparisonPageDTO, PublicApplicationChangesPageDTO, CompactPageDTO, Diagnostic } from '@ce/contracts';
import type { Observable } from 'rxjs';
import { inject, Injectable, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import type { HttpResponse } from '@angular/common/http';
import { firstValueFrom, fromEvent, takeUntil, Subject, tap } from 'rxjs';
import type { BootstrapDTO, CapabilitiesDTO, DirectionChoiceDTO, DirectionsResponseDTO, JobDTO, RulesPageDTO, WorkspaceDTO, ValidationResultsPageDTO } from '@ce/contracts';
import type { HostedBootstrapDTO, DemoSessionDTO } from '@ce/contracts';
import type { CompactWorkspaceDTO, CompactContextsPageDTO, LargeValueDescriptorDTO, ExportManifestDTO } from '@ce/contracts';
import { checkTransferCancellation, readVerifiedValue, readVerifiedExport } from './verified-transfer';
import { sha256Bytes } from './verified-transfer';
import { uploadFilesForInspection } from './upload-transfer';
import type { UploadProgress } from './upload-transfer';
import { UploadAttemptStore } from './upload-attempt.store';
import type { UploadBatchCreateDTO, UploadBatchDTO, TransferPartDTO } from '@ce/contracts';
import type { CompactImportInspectionDTO, CompactImportInspectionPageDTO, ImportInspectionSection } from '@ce/contracts';
import type { CompactRulesPageDTO, CompactResultsPageDTO, ResultExplanationDTO, ResultExplanationPageDTO, ResultExplanationSection } from '@ce/contracts';
import { sameDownloadIntent } from '@ce/contracts';
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
  readonly connection = inject(CONNECTION_CONFIG);
  private readonly apiRoot = this.connection.apiBaseUrl + '/api/v1';
  readonly sessionEnded = new Subject<HttpErrorResponse>();
  readonly actionAccepted = new Subject<void>();
  private readonly uploads=inject(UploadAttemptStore);
  readonly uploadProgress=signal<UploadProgress|null>(null);
  pendingUpload(workspaceId:string){return this.uploads.get(workspaceId);}
  private send<T>(source: Observable<T>, meaningful = false): Promise<T> {
    if(this.connection.error)return Promise.reject(new Error(this.connection.error));
    const epoch=this.tokenEpoch;
    return firstValueFrom(source.pipe(tap({next:()=>{if(epoch!==this.tokenEpoch)throw new Error('La respuesta pertenece a una sesión anterior.');if(meaningful)this.actionAccepted.next();},error:(error:unknown)=>{
      if(error instanceof HttpErrorResponse&&(error.status===401||['SESSION_UNAUTHENTICATED','INVALID_SESSION','SESSION_EXPIRED','SESSION_REVOKED'].includes(String(error.error?.error?.code))))this.sessionEnded.next(error);
    }})));
  }
  private token: string | undefined;
  private tokenEpoch=0;
  private readonly transfers=new Set<AbortController>();
  private exportBytes:{workspaceId:string;artifactId:string;sha256:string;parts:Map<number,Uint8Array<ArrayBuffer>>}|undefined;
  setSessionToken(token: string): void { if(this.token!==token){this.tokenEpoch++;for(const controller of this.transfers)controller.abort();}this.token = token; }
  clearSession(): void { this.tokenEpoch++;this.token = undefined;this.exportBytes=undefined;for(const controller of this.transfers)controller.abort();this.transfers.clear(); }
  private openTransfer(parent:AbortSignal){const controller=new AbortController(),abort=()=>controller.abort();parent.addEventListener('abort',abort,{once:true});if(parent.aborted)controller.abort();this.transfers.add(controller);return{signal:controller.signal,close:()=>{parent.removeEventListener('abort',abort);this.transfers.delete(controller);}};}
  private headers(etag?: string): HttpHeaders {
    let headers = new HttpHeaders();
    if (this.token) headers = headers.set('X-CE-Session', this.token);
    if (etag) headers = headers.set('If-Match', etag);
    return headers;
  }
  bootstrap(): Promise<BootstrapDTO|HostedBootstrapDTO> { return this.send(this.http.get<BootstrapDTO|HostedBootstrapDTO>(this.apiRoot + '/bootstrap')); }
  createDemoSession(creationNonce:string):Promise<DemoSessionDTO>{return this.send(this.http.post<DemoSessionDTO>(this.apiRoot+'/sessions',{creationNonce},{headers:this.headers()}));}
  demoSession():Promise<DemoSessionDTO>{return this.send(this.http.get<DemoSessionDTO>(this.apiRoot+'/session',{headers:this.headers()}));}
  revokeDemoSession(key:string):Promise<void>{return this.send(this.http.delete<void>(this.apiRoot+'/session',{headers:this.headers().set('Idempotency-Key',key)}));}
  createWorkspace(name: string,key?:string): Promise<HttpResponse<WorkspaceDTO|CompactWorkspaceDTO>> {
    return this.send(this.http.post<WorkspaceDTO|CompactWorkspaceDTO>(this.apiRoot + '/workspaces', { name }, { headers: key?this.headers().set('Idempotency-Key',key):this.headers(), observe: 'response' }), true);
  }
  workspace(id: string): Promise<HttpResponse<WorkspaceDTO|CompactWorkspaceDTO>> {
    return this.send(this.http.get<WorkspaceDTO|CompactWorkspaceDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(id), { headers: this.headers(), params:{compact:'true'}, observe: 'response' }));
  }
  contexts(workspaceId:string,query:{cursor?:string;contextId?:string}={}):Promise<CompactContextsPageDTO>{return this.send(this.http.get<CompactContextsPageDTO>(this.apiRoot+'/workspaces/'+encodeURIComponent(workspaceId)+'/contexts',{headers:this.headers(),params:{limit:'50',...query}}));}
  async largeValue<T>(workspaceId:string,descriptor:LargeValueDescriptorDTO,signal:AbortSignal=new AbortController().signal):Promise<T>{
    const transfer=this.openTransfer(signal);try{return await readVerifiedValue<T>(descriptor,index=>this.binaryPart(`${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/values/${encodeURIComponent(descriptor.valueRef)}/parts/${index}`,transfer.signal),transfer.signal);}finally{transfer.close();}
  }
  /** Hydrate only the requested page. Nested individual values remain descriptors until opened. */
  private async publicPage<T extends {readonly items:readonly unknown[]}>(workspaceId:string,request:Promise<PublicItemsPage<T>>):Promise<T>{
    const epoch=this.tokenEpoch,page=await request,items:unknown[]=[];
    for(const row of page.items){
      if(epoch!==this.tokenEpoch)throw new Error('La consulta pertenece a una sesión anterior.');
      items.push(isLargeValue(row)?await this.largeValue(workspaceId,row):row);
    }
    if(epoch!==this.tokenEpoch)throw new Error('La consulta pertenece a una sesión anterior.');
    return {...page,items} as unknown as T;
  }
  private async publicDetail<T>(workspaceId:string,request:Promise<PublicValue<T>>):Promise<T>{const epoch=this.tokenEpoch,value=await request;if(epoch!==this.tokenEpoch)throw new Error('La consulta pertenece a una sesión anterior.');return isLargeValue(value)?this.largeValue<T>(workspaceId,value):value;}
  private async binaryPart(url:string,signal:AbortSignal){checkTransferCancellation(signal);const response=await this.send(this.http.get(url,{headers:this.headers(),responseType:'arraybuffer',observe:'response'}).pipe(takeUntil(fromEvent(signal,'abort'))));checkTransferCancellation(signal);return {bytes:new Uint8Array(response.body!),sha256:response.headers.get('X-CE-Part-SHA256')};}
  closeWorkspace(id: string, etag: string): Promise<void> {
    return this.send(this.http.delete<void>(this.apiRoot + '/workspaces/' + encodeURIComponent(id), { headers: this.headers(etag) }), true);
  }
  job(workspaceId: string, jobId: string): Promise<JobDTO> {
    return this.send(this.http.get<JobDTO>(this.jobUrl(workspaceId, jobId), { headers: this.headers() }));
  }
  cancelJob(workspaceId: string, jobId: string): Promise<JobDTO> {
    return this.send(this.http.delete<JobDTO>(this.jobUrl(workspaceId, jobId), { headers: this.headers() }), true);
  }
  operation(id: string): Promise<OperationReceiptDTO> { return this.send(this.http.get<OperationReceiptDTO>(this.apiRoot + '/operations/' + encodeURIComponent(id), { headers: this.headers() })); }
  operationReceipt(key: string): Promise<OperationReceiptDTO> { return this.send(this.http.get<OperationReceiptDTO>(this.apiRoot + '/operation-receipts/' + encodeURIComponent(key), { headers: this.headers() })); }
  recalculationState(workspaceId: string): Promise<RecalculationStateDTO> {
    return this.send(this.http.get<RecalculationStateDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/recalculation-state', { headers: this.headers() }));
  }
  recalculate(workspaceId: string, body: RecalculationOperationRequestDTO, etag: string, key: string): Promise<RecalculationOperationAcceptedDTO> {
    return this.send(this.http.post<RecalculationOperationAcceptedDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/recalculation-operations', body, { headers: this.headers(etag).set('Idempotency-Key', key) }), true);
  }
  capabilities(): Promise<CapabilitiesDTO> { return this.send(this.http.get<CapabilitiesDTO>(this.apiRoot + '/capabilities', { headers: this.headers() })); }
  corepTemplate(): Promise<Blob> { return this.send(this.http.get(this.apiRoot + '/templates/corep-ca1', { headers: this.headers(), responseType: 'blob' })); }
  visualDemo(kind: 'corep' | 'types' | 'finrep', artifact: 'catalog' | 'report'): Promise<Blob> { return this.send(this.http.get(`${this.apiRoot}/templates/demos/${kind}/${artifact}`, { headers: this.headers(), responseType: 'blob' })); }
  activeImportInspection(workspaceId: string): Promise<{active:CompactImportInspectionDTO|ImportInspectionDTO|null}> { return this.send(this.http.get<{active:CompactImportInspectionDTO|ImportInspectionDTO|null}>(this.inspectionsUrl(workspaceId), { headers: this.headers(),params:{compact:'true'} })); }
  importInspection(workspaceId: string, id: string): Promise<CompactImportInspectionDTO|ImportInspectionDTO> { return this.send(this.http.get<CompactImportInspectionDTO|ImportInspectionDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id), { headers: this.headers(),params:{compact:'true'} })); }
  importInspectionItems(workspaceId:string,id:string,section:ImportInspectionSection,query:{cursor?:string}={}):Promise<CompactImportInspectionPageDTO>{return this.send(this.http.get<CompactImportInspectionPageDTO>(this.inspectionsUrl(workspaceId)+'/'+encodeURIComponent(id)+'/items',{headers:this.headers(),params:{section,limit:'50',...query}}));}
  async inspectImport(workspaceId: string, etag: string, catalog: File, reports: readonly File[], context: ImportContextInputDTO, key: string, signal: AbortSignal,baseVersionId:string|null=null): Promise<JobDTO> {
    const transfer=this.openTransfer(signal);signal=transfer.signal;
    const batchUrl=`${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/upload-batches`;
    const send=<T>(request:Observable<T>)=>{checkTransferCancellation(signal);return this.send(request.pipe(takeUntil(fromEvent(signal,'abort'))));};
    try{
      const uploadBatchId=await uploadFilesForInspection(workspaceId,baseVersionId,etag,catalog,reports,this.uploads,{
        create:(body:UploadBatchCreateDTO,stableKey,originalEtag)=>send(this.http.post<UploadBatchDTO>(batchUrl,body,{headers:this.headers(originalEtag).set('Idempotency-Key',stableKey)})),
        get:id=>send(this.http.get<UploadBatchDTO>(batchUrl+'/'+encodeURIComponent(id),{headers:this.headers()})),
        put:(batchId,fileId,index,bytes,hash)=>send(this.http.post<TransferPartDTO>(`${batchUrl}/${encodeURIComponent(batchId)}/files/${encodeURIComponent(fileId)}/parts/${index}`,bytes.buffer,{headers:this.headers().set('Content-Type','application/octet-stream').set('X-CE-Part-SHA256',hash)})),
        seal:(batchId,base,stableKey,originalEtag)=>send(this.http.post<JobDTO>(batchUrl+'/'+encodeURIComponent(batchId)+'/seal',{baseVersionId:base},{headers:this.headers(originalEtag).set('Idempotency-Key',stableKey)})),
        job:id=>send(this.http.get<JobDTO>(this.jobUrl(workspaceId,id),{headers:this.headers()})),
      },signal,this.connection.deploymentProfile==='local'?250:5000,value=>this.uploadProgress.set(value));
      checkTransferCancellation(signal);let attempt=this.uploads.get(workspaceId);if(!attempt)throw new Error('La carga ya no pertenece a la sesión activa.');
      const contextHash=await sha256Bytes(new TextEncoder().encode(JSON.stringify(context)));
      checkTransferCancellation(signal);
      if(attempt.inspectionJobId&&attempt.contextHash===contextHash){const job=await send(this.http.get<JobDTO>(this.jobUrl(workspaceId,attempt.inspectionJobId),{headers:this.headers()}));if(['queued','running','succeeded'].includes(job.status))return job;}
      const inspectionKey=attempt.contextHash===contextHash&&!attempt.inspectionJobId&&attempt.inspectionKey?attempt.inspectionKey:key;
      const {inspectionJobId:_old,...retained}=attempt;attempt={...retained,inspectionKey,contextHash};this.uploads.save(attempt);
      const job=await this.send(this.http.post<JobDTO>(this.inspectionsUrl(workspaceId),{uploadBatchId,context},{headers:this.headers(attempt.etag).set('Idempotency-Key',inspectionKey)}).pipe(takeUntil(fromEvent(signal,'abort'))),true);
      checkTransferCancellation(signal);this.uploads.save({...attempt,inspectionJobId:job.jobId});return job;
    }finally{transfer.close();this.uploadProgress.set(null);}
  }
  async discardUpload(workspaceId:string):Promise<void>{const attempt=this.uploads.get(workspaceId);if(!attempt)return;if(!attempt.batchId)throw new Error('Primero vuelve a seleccionar los mismos archivos para recuperar la carga, o cierra la sesión para descartarla.');await this.send(this.http.delete<void>(`${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/upload-batches/${encodeURIComponent(attempt.batchId)}`,{headers:this.headers()}));this.uploads.clear(workspaceId);}
  commitImportInspection(workspaceId: string, id: string, body: ImportInspectionCommitDTO, etag: string, key: string): Promise<JobDTO> { return this.send(this.http.post<JobDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id) + '/commit', body, { headers: this.headers(etag).set('Idempotency-Key', key) }), true); }
  discardImportInspection(workspaceId: string, id: string, etag: string): Promise<CompactImportInspectionDTO|ImportInspectionDTO> { return this.send(this.http.delete<CompactImportInspectionDTO|ImportInspectionDTO>(this.inspectionsUrl(workspaceId) + '/' + encodeURIComponent(id), { headers: this.headers(etag),params:{compact:'true'} }), true); }
  private inspectionsUrl(workspaceId: string): string { return this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/import-inspections'; }
  rules(workspaceId: string, versionId: string, filters: { code?: string; status?: string; table?: string; cursor?: string } = {}): Promise<RulesPageDTO> {
    return this.send(this.http.get<RulesPageDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/rules',
      { headers: this.headers(), params: { versionId, limit: '50', ...filters } }));
  }
  compactRules(workspaceId:string,versionId:string,filters:{code?:string;status?:string;table?:string;cursor?:string}={}):Promise<CompactRulesPageDTO>{return this.send(this.http.get<CompactRulesPageDTO>(`${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/rules`,{headers:this.headers(),params:{versionId,compact:'true',limit:'50',...filters}}));}
  validate(workspaceId: string, baseVersionId: string, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/validations', { baseVersionId }, { headers: this.headers(etag).set('Idempotency-Key', key) }), true);
  }
  results(workspaceId: string, runId: string, filters: { code?: string; status?: string; table?: string; cursor?: string; includeConfiguredDirections?: boolean } = {}): Promise<ValidationResultsPageDTO> {
    return this.send(this.http.get<ValidationResultsPageDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/runs/' + encodeURIComponent(runId) + '/results', { headers: this.headers(), params: { limit: '50', ...filters } }));
  }
  compactResults(workspaceId:string,runId:string,filters:{code?:string;status?:string;table?:string;cursor?:string}={}):Promise<CompactResultsPageDTO>{return this.send(this.http.get<CompactResultsPageDTO>(this.resultUrl(workspaceId,runId),{headers:this.headers(),params:{compact:'true',limit:'50',...filters}}));}
  resultExplanation(workspaceId:string,runId:string,resultId:string):Promise<ResultExplanationDTO>{return this.publicDetail<ResultExplanationDTO>(workspaceId,this.send(this.http.get<PublicValue<ResultExplanationDTO>>(this.resultUrl(workspaceId,runId)+'/'+encodeURIComponent(resultId)+'/explanation',{headers:this.headers()}))).then(detail=>({...detail,workspaceId:detail.workspaceId??workspaceId}));}
  resultExplanationItems(workspaceId:string,runId:string,resultId:string,section:ResultExplanationSection,cursor?:string):Promise<ResultExplanationPageDTO>{return this.send(this.http.get<ResultExplanationPageDTO>(this.resultUrl(workspaceId,runId)+'/'+encodeURIComponent(resultId)+'/explanation/items',{headers:this.headers(),params:{section,limit:'50',...(cursor?{cursor}:{})}}));}
  private resultUrl(workspaceId:string,runId:string):string{return `${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/results`;}
  private reviewsUrl(workspaceId: string, reviewId?: string): string {
    const collection = this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/recalculation-reviews';
    return reviewId ? collection + '/' + encodeURIComponent(reviewId) : collection;
  }
  activeDirectionReviews(workspaceId: string): Promise<DirectionReviewActiveDTO> {
    return this.send(this.http.get<DirectionReviewActiveDTO>(this.reviewsUrl(workspaceId), { headers: this.headers() }));
  }
  directionReview(workspaceId: string, id: string): Promise<DirectionReviewSummaryDTO> {
    return this.send(this.http.get<DirectionReviewSummaryDTO>(this.reviewsUrl(workspaceId, id), { headers: this.headers() }));
  }
  directionReviewRows(workspaceId: string, id: string, filters: { cursor?: string; groupId?: string; state?: DirectionReviewDecision; scope?: 'pending'|'resolved'|'all' }): Promise<DirectionReviewPageDTO> {
    return this.publicPage<DirectionReviewPageDTO>(workspaceId,this.send(this.http.get<PublicItemsPage<DirectionReviewPageDTO>>(this.reviewsUrl(workspaceId, id) + '/rows', { headers:this.headers(), params:{compact:'true',limit:'50',...filters} })));
  }
  directionConflictGroups(workspaceId: string, id: string, query: { cursor?: string; scope?: 'pending'|'resolved'|'all' } = {}): Promise<DirectionConflictGroupsPageDTO> {
    return this.publicPage<DirectionConflictGroupsPageDTO>(workspaceId,this.send(this.http.get<PublicItemsPage<DirectionConflictGroupsPageDTO>>(this.reviewsUrl(workspaceId, id) + '/groups', { headers: this.headers(), params: { compact: 'true', limit: '50', ...query } })));
  }
  directionConflictCandidates(workspaceId: string, id: string, groupId: string, query: { cursor?: string } = {}): Promise<DirectionConflictCandidatesPageDTO> {
    return this.publicPage<DirectionConflictCandidatesPageDTO>(workspaceId,this.send(this.http.get<PublicItemsPage<DirectionConflictCandidatesPageDTO>>(this.reviewsUrl(workspaceId, id) + '/groups/' + encodeURIComponent(groupId) + '/candidates', { headers: this.headers(), params: { compact: 'true', limit: '50', ...query } })));
  }
  directionConflictCandidate(workspaceId: string, id: string, groupId: string, instanceId: string): Promise<DirectionConflictCandidateDetailDTO> {
    return this.publicDetail<DirectionConflictCandidateDetailDTO>(workspaceId,this.send(this.http.get<PublicValue<DirectionConflictCandidateDetailDTO>>(this.reviewsUrl(workspaceId, id) + '/groups/' + encodeURIComponent(groupId) + '/candidates/' + encodeURIComponent(instanceId), { headers: this.headers(),params:{compact:'true'} }))).then(async detail=>{
      const resolve=<T>(value:PublicValue<T>)=>isLargeValue(value)?this.largeValue<T>(workspaceId,value):Promise.resolve(value);
      return {...detail,expression:await resolve(detail.expression),...(detail.precondition===undefined?{}:{precondition:await resolve(detail.precondition)}),descriptions:await resolve(detail.descriptions)};
    });
  }
  prepareDirectionReview(workspaceId: string, body: DirectionReviewPrepareDTO, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.reviewsUrl(workspaceId), body, {headers:this.headers(etag).set('Idempotency-Key',key)}));
  }
  editDirectionReview(workspaceId: string, id: string, body: DirectionReviewPatchDTO, etag: string): Promise<DirectionReviewMutationResponseDTO> {
    return this.send(this.http.patch<DirectionReviewMutationResponseDTO>(this.reviewsUrl(workspaceId,id), body, {headers:this.headers(etag)}), true);
  }
  commitDirectionReview(workspaceId: string, id: string, body: DirectionReviewCommitDTO, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.reviewsUrl(workspaceId,id) + '/commit', body, {headers:this.headers(etag).set('Idempotency-Key',key)}), true);
  }
  discardDirectionReview(workspaceId: string, id: string, etag: string): Promise<DirectionReviewSummaryDTO> {
    return this.send(this.http.delete<DirectionReviewSummaryDTO>(this.reviewsUrl(workspaceId,id), {headers:this.headers(etag)}), true);
  }
  replaceDirections(workspaceId: string, directions: readonly DirectionChoiceDTO[], etag: string): Promise<HttpResponse<DirectionsResponseDTO>> {
    return this.send(this.http.put<DirectionsResponseDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/directions', { directions }, { headers: this.headers(etag), observe: 'response' }), true);
  }
  runs(workspaceId: string, cursor?: string): Promise<HistoryPageDTO<RunSummaryDTO>> {
    return this.send(this.http.get<HistoryPageDTO<RunSummaryDTO>>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/runs', { headers: this.headers(), params: { limit: '50', ...(cursor ? { cursor } : {}) } }));
  }
  previews(workspaceId: string, cursor?: string): Promise<HistoryPageDTO<PreviewSummaryDTO>> {
    return this.send(this.http.get<HistoryPageDTO<PreviewSummaryDTO>>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/previews', { headers: this.headers(), params: { limit: '50', ...(cursor ? { cursor } : {}) } }));
  }
  createPreview(workspaceId: string, baseVersionId: string, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/previews', { baseVersionId }, { headers: this.headers(etag).set('Idempotency-Key', key) }), true);
  }
  preview(workspaceId: string, previewId: string): Promise<PreviewDTO> { return this.send(this.http.get<PreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers() })); }
  previewCompact(workspaceId: string, previewId: string): Promise<CompactPreviewDTO> { return this.send(this.http.get<CompactPreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers(), params: { compact: 'true' } })); }
  proposal(workspaceId: string, previewId: string, proposalId: string): Promise<ProposalDTO> { return this.send(this.http.get<ProposalDTO>(this.previewUrl(workspaceId, previewId) + '/proposals/' + encodeURIComponent(proposalId), { headers: this.headers() })); }
  proposals(workspaceId: string, previewId: string, filters: { status?: string; code?: string; table?: string; contextId?: string; cursor?: string } = {}): Promise<ProposalsPageDTO> {
    return this.send(this.http.get<ProposalsPageDTO>(this.previewUrl(workspaceId, previewId) + '/proposals', { headers: this.headers(), params: { limit: '50', ...filters } }));
  }
  previewSelection(workspaceId: string, previewId: string, selectedIds: readonly string[]): Promise<PreviewSelectionDTO> {
    return this.send(this.http.post<PreviewSelectionDTO>(this.previewUrl(workspaceId, previewId) + '/selection', { selectedIds }, { headers: this.headers() }));
  }
  proposalSelectionState(workspaceId: string, previewId: string): Promise<ProposalSelectionSummaryDTO> {
    return this.send(this.http.get<ProposalSelectionSummaryDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state', { headers: this.headers() }));
  }
  prepareProposalSelection(workspaceId: string, previewId: string, baseVersionId: string, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state', { baseVersionId, seed: 'empty' }, { headers: this.headers(etag).set('Idempotency-Key', key) }), true);
  }
  editProposalSelection(workspaceId: string, previewId: string, body: ProposalSelectionEditDTO, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.previewUrl(workspaceId, previewId) + '/selection-state/edits', body, { headers: this.headers(etag).set('Idempotency-Key', key) }), true);
  }
  selectionRows(workspaceId: string, previewId: string, query: ProposalSelectionRowsQueryDTO = {}): Promise<ProposalSelectionPageDTO> {
    return this.publicPage<ProposalSelectionPageDTO>(workspaceId,this.send(this.http.get<PublicItemsPage<ProposalSelectionPageDTO>>(this.previewUrl(workspaceId, previewId) + '/selection-state/rows', { headers: this.headers(), params: { compact: 'true', limit: '50', ...query } })));
  }
  selectionDependencies(workspaceId: string, previewId: string, proposalId: string, query: { scope?: 'all' | 'missing'; cursor?: string } = {}): Promise<ProposalDependencyPageDTO> {
    return this.publicPage<ProposalDependencyPageDTO>(workspaceId,this.send(this.http.get<PublicItemsPage<ProposalDependencyPageDTO>>(this.previewUrl(workspaceId, previewId) + '/selection-state/proposals/' + encodeURIComponent(proposalId) + '/dependencies', { headers: this.headers(), params: { compact: 'true', limit: '50', ...query } })));
  }
  proposalExplanation(workspaceId: string, previewId: string, proposalId: string): Promise<ProposalExplanationDTO> {
    return this.publicDetail<ProposalExplanationDTO>(workspaceId,this.send(this.http.get<PublicValue<ProposalExplanationDTO>>(this.previewUrl(workspaceId, previewId) + '/selection-state/proposals/' + encodeURIComponent(proposalId) + '/explanation', { headers: this.headers(),params:{compact:'true'} })));
  }
  proposalExplanationItems(workspaceId: string, previewId: string, proposalId: string, query: { section: ProposalExplanationSection; cursor?: string }): Promise<ProposalExplanationPageDTO> {
    return this.publicPage<ProposalExplanationPageDTO>(workspaceId,this.send(this.http.get<PublicItemsPage<ProposalExplanationPageDTO>>(this.previewUrl(workspaceId, previewId) + '/selection-state/proposals/' + encodeURIComponent(proposalId) + '/explanation/items', { headers: this.headers(), params: { compact: 'true', limit: '50', ...query } })));
  }
  discardPreview(workspaceId: string, previewId: string, etag: string): Promise<PreviewDTO> { return this.send(this.http.delete<PreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers(etag) }), true); }
  discardPreviewCompact(workspaceId: string, previewId: string, etag: string): Promise<CompactPreviewDTO> { return this.send(this.http.delete<CompactPreviewDTO>(this.previewUrl(workspaceId, previewId), { headers: this.headers(etag), params: { compact: 'true' } }), true); }
  apply(workspaceId: string, body: ApplicationRequestDTO, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/applications', body, { headers: this.headers(etag).set('Idempotency-Key', key) }), true);
  }
  application(workspaceId: string, receiptId: string): Promise<ApplicationDetailDTO> {
    return this.send(this.http.get<ApplicationDetailDTO>(this.applicationUrl(workspaceId, receiptId), { headers: this.headers() }));
  }
  applicationCompact(workspaceId: string, receiptId: string): Promise<CompactApplicationDetailDTO> {
    return this.send(this.http.get<CompactApplicationDetailDTO>(this.applicationUrl(workspaceId, receiptId), { headers: this.headers(), params: { includeAcceptedIds: 'false' } }));
  }
  comparisonCompact(workspaceId: string, receiptId: string, filters: { cursor?: string; changedOnly?: boolean } = {}): Promise<ResolvedItemsPage<PublicComparisonPageDTO>> {
    return this.publicPage<ResolvedItemsPage<PublicComparisonPageDTO>>(workspaceId,this.send(this.http.get<PublicComparisonPageDTO>(this.applicationUrl(workspaceId, receiptId) + '/comparison', { headers: this.headers(), params: { compact: 'true', limit: '50', includeAcceptedIds: 'false', ...(filters.cursor ? { cursor: filters.cursor } : {}), ...(filters.changedOnly === undefined ? {} : { changedOnly: String(filters.changedOnly) }) } })));
  }
  applicationChanges(workspaceId:string,receiptId:string,cursor?:string):Promise<ResolvedItemsPage<PublicApplicationChangesPageDTO>> {
    return this.publicPage<ResolvedItemsPage<PublicApplicationChangesPageDTO>>(workspaceId,this.send(this.http.get<PublicApplicationChangesPageDTO>(this.applicationUrl(workspaceId,receiptId)+'/changes',{headers:this.headers(),params:{limit:'50',...(cursor?{cursor}:{})}})));
  }
  runDiagnostics(workspaceId:string,runId:string,cursor?:string):Promise<CompactPageDTO<PublicValue<Diagnostic>>> {
    return this.send(this.http.get<CompactPageDTO<PublicValue<Diagnostic>>>(`${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/diagnostics`,{headers:this.headers(),params:{limit:'50',...(cursor?{cursor}:{})}}));
  }
  comparison(workspaceId: string, receiptId: string, filters: { cursor?: string; changedOnly?: boolean } = {}): Promise<ComparisonPageDTO> {
    return this.send(this.http.get<ComparisonPageDTO>(this.applicationUrl(workspaceId, receiptId) + '/comparison', { headers: this.headers(), params: { limit: '50', ...(filters.cursor ? { cursor: filters.cursor } : {}), ...(filters.changedOnly === undefined ? {} : { changedOnly: String(filters.changedOnly) }) } }));
  }
  private applicationUrl(workspaceId: string, receiptId: string): string { return this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/applications/' + encodeURIComponent(receiptId); }
  private previewUrl(workspaceId: string, previewId: string): string { return this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/previews/' + encodeURIComponent(previewId); }
  exportResults(workspaceId: string, versionId: string, runId: string, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/exports', { versionId, runId, kind: 'results' }, { headers: this.headers(etag).set('Idempotency-Key', key) }), true);
  }
  exportSummary(workspaceId: string, versionId: string, kind: 'report' | 'results' = 'report', runId?: string): Promise<VersionExportSummaryDTO> {
    const params = new HttpParams().set('kind', kind); const query = kind === 'results' && runId ? params.set('runId', runId) : params;
    return this.send(this.http.get<PublicValue<VersionExportSummaryDTO> & Partial<Pick<VersionExportSummaryDTO,'intent'|'intentFingerprint'>>>(`${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/versions/${encodeURIComponent(versionId)}/export-summary`, { headers: this.headers(), params: query })).then(async value=>{if(!isLargeValue(value))return value;const summary=await this.largeValue<VersionExportSummaryDTO>(workspaceId,value);return {...summary,...(value.intent?{intent:value.intent}:{}),...(value.intentFingerprint?{intentFingerprint:value.intentFingerprint}:{})};});
  }
  exportArtifactSummary(workspaceId: string, exportId: string): Promise<ExportArtifactSummaryDTO> {
    return this.send(this.http.get<ExportArtifactSummaryDTO>(`${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/exports/${encodeURIComponent(exportId)}`, { headers: this.headers().set('Accept', 'application/json') }));
  }
  exportReport(workspaceId: string, versionId: string, etag: string, key: string): Promise<JobDTO> {
    return this.send(this.http.post<JobDTO>(this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/exports', { versionId, kind: 'report' }, { headers: this.headers(etag).set('Idempotency-Key', key) }), true);
  }
  async downloadExport(workspaceId: string, exportId: string, signal:AbortSignal=new AbortController().signal,expected?:ExportArtifactSummaryDTO): Promise<Blob> {
    const transfer=this.openTransfer(signal);signal=transfer.signal;try{
    checkTransferCancellation(signal);const url=`${this.apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/exports/${encodeURIComponent(exportId)}`;
    const manifest=await this.send(this.http.get<ExportManifestDTO>(url+'/manifest',{headers:this.headers()}).pipe(takeUntil(fromEvent(signal,'abort'))));checkTransferCancellation(signal);
    if(manifest.artifactId!==exportId||manifest.intent.workspaceId!==workspaceId)throw new Error('El archivo no corresponde a esta descarga.');
    if(expected&&(!sameDownloadIntent(manifest.intent,expected.intent)||manifest.sha256!==expected.sha256||manifest.byteLength!==expected.size))throw new Error('El contenido del archivo no coincide con la versión solicitada.');
    if(this.exportBytes?.workspaceId!==workspaceId||this.exportBytes?.artifactId!==exportId||this.exportBytes.sha256!==manifest.sha256)this.exportBytes={workspaceId,artifactId:exportId,sha256:manifest.sha256,parts:new Map()};
    return await readVerifiedExport(manifest,this.exportBytes.parts,index=>this.binaryPart(url+'/parts/'+index,signal),signal);
    }finally{transfer.close();}
  }
  private jobUrl(workspaceId: string, jobId: string): string {
    return this.apiRoot + '/workspaces/' + encodeURIComponent(workspaceId) + '/jobs/' + encodeURIComponent(jobId);
  }
}
