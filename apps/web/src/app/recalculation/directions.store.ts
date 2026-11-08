import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { DirectionReviewDecision, DirectionReviewOperationDTO, DirectionReviewPageDTO, DirectionReviewPatchDTO,
  RecalculationReviewPrepareDTO, RecalculationOperationRequestDTO, RecalculationStateDTO, DirectionReviewRowDTO, DirectionReviewSummaryDTO, JobDTO, TargetSide,
  DirectionConflictGroupDTO, DirectionConflictGroupsPageDTO, DirectionConflictCandidatesPageDTO, DirectionConflictCandidateDetailDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { CursorPage, CursorPageError } from '../core/cursor-page';
import { SessionStore } from '../core/session.store';
import { StageFocus } from '../core/stage-title.directive';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';
type Attempt = {workspaceId:string;etag:string} & ({kind:'prepare';body:RecalculationReviewPrepareDTO;key:string}|{kind:'edit';id:string;body:DirectionReviewPatchDTO});
interface GroupEditor { group: DirectionConflictGroupDTO; revision: number; value: string | null | undefined; original: string | null | undefined; code?: string }
const errorMessage=(e:unknown)=>e instanceof HttpErrorResponse && typeof e.error?.error?.message==='string'?e.error.error.message as string:e instanceof CursorPageError?e.message:'No se pudo completar la revisión de destinos.';
@Injectable({providedIn:'root'})
export class DirectionsStore {
 readonly session=inject(SessionStore); private readonly api=inject(ApiClient); private readonly view=inject(WorkspaceViewStore);
 private readonly focus=inject(StageFocus,{optional:true});
 private alive=true; private active=false; private boundWorkspaceId=''; private lookupGeneration=0; private rowGeneration=0;
 private groupsGeneration=0; private candidatesGeneration=0; private detailGeneration=0; private confirmingGroupId:string|null=null;
 private expiryTimer?:ReturnType<typeof setTimeout>; private attempt:Attempt|null=null; private observedJob:{jobId:string;reviewId?:string}|null=null;
 private synchronized=signal(false); private staleEditor=signal(false);
 readonly state=signal<RecalculationStateDTO|null>(null); readonly run=computed(()=>this.state()?.compatibleRun??null);
 readonly review=signal<DirectionReviewSummaryDTO|null>(null); readonly rows=signal<DirectionReviewPageDTO|null>(null);
 readonly groups=signal<DirectionConflictGroupsPageDTO|null>(null); readonly groupsPagination=new CursorPage(); readonly candidatesPagination=new CursorPage();
 readonly groupsLoading=signal(false); readonly candidatesLoading=signal(false); readonly editor=signal<GroupEditor|null>(null);
 readonly candidates=signal<DirectionConflictCandidatesPageDTO|null>(null); readonly candidateDetail=signal<DirectionConflictCandidateDetailDTO|null>(null); readonly candidateDetailLoading=signal(false);
 readonly anchoredGroup=signal<DirectionConflictGroupDTO|null>(null);
 readonly displayGroups=computed(()=>{const items=this.groups()?.items??[],anchor=this.anchoredGroup();return anchor&&!items.some(g=>g.groupId===anchor.groupId)?[...items,anchor]:items;});
 readonly hasUnsavedChoice=computed(()=>!!this.editor()&&this.editor()!.value!==this.editor()!.original);
 readonly selectedOutsidePage=computed(()=>!!this.editor()?.value&&!this.candidates()?.items.some(r=>r.instanceId===this.editor()?.value));
 readonly rowScope=signal<'pending'|'resolved'|'all'>('pending'); readonly stateFilter=signal<DirectionReviewDecision|''>(''); readonly groupFilter=signal(''); readonly pagination=new CursorPage();
 readonly uncertain=signal(false); readonly pending=signal(false); readonly looking=signal(false); readonly loading=signal(false); readonly expired=signal(false); readonly error=signal('');
 readonly operationLocked=signal(false);
 readonly historical=computed(()=>!!this.state()&&this.state()!.currentVersionId!==this.session.versionId());
 readonly complete=computed(()=>!!this.state()?.compatibleRun); readonly busy=computed(()=>this.pending()||this.looking()||this.loading()||this.groupsLoading()||this.candidatesLoading()||this.session.pending()||this.session.jobActive());
 readonly editable=computed(()=>this.synchronized()&&this.complete()&&!this.historical()&&!this.staleEditor()&&!this.expired()&&!this.uncertain()&&!this.operationLocked()&&!this.busy()&&this.review()?.state==='ready'&&this.rows()?.revision===this.review()?.revision);
 readonly pendingCount=computed(()=>{const c=this.review()?.counts;return c?c.pending+c.conflicted+c.undetermined:null;});
 readonly allOmitted=computed(()=>{const c=this.review()?.counts;return !!c&&c.omitted>0&&c.included===0&&this.pendingCount()===0;});
 readonly canSimulate=computed(()=>this.editable()&&!this.hasUnsavedChoice()&&this.pendingCount()===0&&this.review()?.conflictGroupCount===0&&this.state()?.state!=='no_candidates');
 readonly configurable=computed(()=>(this.rows()?.items??[]).filter(r=>['included','pending','omitted'].includes(r.state)));
 readonly unavailable=computed(()=>(this.rows()?.items??[]).filter(r=>r.state==='undetermined'));
 readonly resultPresentation=computed(()=>{const job=this.session.job(),r=this.review();return job?.workspaceId===this.session.workspace()?.id&&job?.status==='succeeded'&&job.kind==='prepare-directions'&&job.resultRef?.id===r?.id&&this.rows()?.revision===r?.revision&&this.groups()?.revision===r?.revision?{jobId:job.jobId,workspaceId:job.workspaceId,versionId:job.baseVersionId??null}:null;});
 constructor(){
  effect(()=>{const version=this.session.versionId(),workspace=this.session.workspace()?.id;untracked(()=>{
   if(!this.active)return;
   if(this.hasUnsavedChoice()&&(workspace!==this.boundWorkspaceId||version!==this.state()?.currentVersionId)){this.staleEditor.set(true);this.error.set('La base ha cambiado. Confirma o cancela la elección pendiente antes de actualizar.');return;}
   if(workspace&&this.state()&&version!==this.state()!.currentVersionId&&!this.session.jobActive())void this.recover();
  });});
  effect(()=>{const job=this.session.job();if(!job||job.workspaceId!==this.session.workspace()?.id||!isTerminalJob(job.status)||job.jobId!==this.observedJob?.jobId)return;this.observedJob=null;untracked(()=>{void this.finishJob(job);});});
  inject(DestroyRef).onDestroy(()=>{this.alive=false;clearTimeout(this.expiryTimer);this.lookupGeneration++;this.rowGeneration++;this.groupsGeneration++;this.candidatesGeneration++;this.detailGeneration++;});
 }
 activate():void {this.active=true;void this.recover();}
 deactivate():void {this.active=false;}
 navigate(stage:'validation'|'exports'):void {if(this.allowLeaveEditor()){this.focus?.request(stage==='validation'?'validation-title':'exports-title');this.view.visit(stage);}}
 simulationInput():RecalculationOperationRequestDTO|null {const s=this.state(),r=this.review();return s&&r&&s.compatibleRun?{baseVersionId:s.currentVersionId,validationBasisId:s.validationBasisId,runId:r.runId,reviewId:r.id,expectedRevision:r.revision}:null;}
 private owns(w:string):boolean{return this.alive&&this.session.workspace()?.id===w;}
 private matches(r:DirectionReviewSummaryDTO):boolean{return this.owns(r.workspaceId)&&!this.historical()&&r.validationBasisId===this.state()?.validationBasisId;}
 async recover(autoPrepare=true):Promise<void>{
  const w=this.session.workspace()?.id,version=this.session.versionId();if(!w||!version)return;
  if(this.hasUnsavedChoice()&&!this.confirmingGroupId){this.allowLeaveEditor();return;}
  if(w!==this.boundWorkspaceId){this.boundWorkspaceId=w;this.resetGroups();this.review.set(null);this.rows.set(null);this.state.set(null);this.attempt=null;this.uncertain.set(false);this.pending.set(false);this.rowScope.set('pending');}
  const generation=++this.lookupGeneration;this.looking.set(true);this.synchronized.set(false);
  let prepare=false;
  try{const state=await this.api.recalculationState(w);if(!this.owns(w)||generation!==this.lookupGeneration||version!==this.session.versionId()||state.currentVersionId!==version)return;
   if(this.hasUnsavedChoice()){this.error.set('Confirma o cancela la elección pendiente antes de actualizar.');return;}
   this.state.set(state);this.synchronized.set(true);this.staleEditor.set(false);
   if(state.review){await this.acceptSummary(state.review);if(state.review.state==='preparing'&&state.review.jobId){const job=await this.api.job(w,state.review.jobId);if(this.owns(w)&&generation===this.lookupGeneration)this.track(job,state.review.id);}}
   else {this.review.set(null);this.rows.set(null);this.resetGroups();}
   prepare=autoPrepare&&state.state==='preparation_required'&&!this.uncertain()&&!this.session.jobActive();
  }catch(e){if(generation===this.lookupGeneration&&this.owns(w)){this.synchronized.set(false);this.error.set(errorMessage(e));}}
  finally{if(generation===this.lookupGeneration)this.looking.set(false);}
  if(prepare&&generation===this.lookupGeneration)await this.prepare();
 }
 private async acceptSummary(summary:DirectionReviewSummaryDTO):Promise<void>{
  if(!this.matches(summary))return;const previous=this.review();if(previous?.id===summary.id&&previous.revision>summary.revision)return;
  if(this.hasUnsavedChoice()&&this.editor()?.revision!==summary.revision&&!this.confirmingGroupId){this.staleEditor.set(true);this.error.set('La revisión cambió. Cancela la elección local para consultar el estado actual.');return;}
  this.review.set(summary);this.state.update(s=>s?{...s,review:summary,counts:summary.counts??null,state:!summary.counts?'preparation_required':summary.counts.pending+summary.counts.conflicted+summary.counts.undetermined>0?'pending':summary.counts.included+summary.counts.omitted>0?'ready':'no_candidates'}:s);
  if(previous?.id!==summary.id||previous.revision!==summary.revision){this.pagination.reset();this.groupsPagination.reset();this.candidatesPagination.reset();if(this.editor()?.revision!==summary.revision)this.invalidateEditor('La revisión cambió.');}
  clearTimeout(this.expiryTimer);this.expired.set(summary.state==='expired');
  if(summary.state==='ready'){
   const remaining=Date.parse(summary.expiresAt??'')-Date.now();if(!(remaining>0)){this.expired.set(true);return;}
   this.expiryTimer=setTimeout(()=>{this.expired.set(true);this.error.set('La revisión ha caducado. Actualiza las decisiones para continuar.');},Math.min(remaining,2147483647));
   await Promise.all([this.loadRows(),this.loadGroups(0,previous?.id!==summary.id)]);
  }else{this.rowGeneration++;this.rows.set(null);this.loading.set(false);}
 }
 async showResolved():Promise<void>{if(!this.allowLeaveEditor())return;this.rowScope.set(this.rowScope()==='pending'?'resolved':'pending');this.stateFilter.set('');this.groupFilter.set('');this.resetGroups();this.pagination.reset();await Promise.all([this.loadRows(),this.loadGroups()]);}
  async loadRows(index = 0): Promise<void> {
    const review = this.review();
    if (!review || review.state !== 'ready' || this.expired() || !this.matches(review)) return;
    if (index !== this.pagination.index() && !this.allowLeaveEditor()) return;
    const generation = ++this.rowGeneration;
    const state = this.stateFilter(), groupId = this.groupFilter(), scope = this.rowScope();
    this.loading.set(true);
    try {
      const request = this.pagination.begin(JSON.stringify([review.id,review.revision,state,groupId,scope]),index);
      const page = await this.api.directionReviewRows(review.workspaceId,review.id,{
        scope, ...(state ? {state} : {}), ...(groupId ? {groupId} : {}), ...(request.cursor ? {cursor:request.cursor} : {}),
      });
      if (generation !== this.rowGeneration || !this.matches(review) || this.review()?.id !== review.id || this.review()?.revision !== review.revision) return;
      if (page.reviewId !== review.id || page.revision !== review.revision) {
        this.rows.set(null); this.error.set('La revisión cambió. Actualiza los destinos antes de continuar.'); return;
      }
      this.pagination.accept(request.index,page.total,page.nextCursor,page.items.length);
      this.rows.set(page);
    } catch (error) {
      if (generation === this.rowGeneration && this.matches(review)) { this.rows.set(null); this.error.set(errorMessage(error)); }
    } finally { if (generation === this.rowGeneration) this.loading.set(false); }
  }
  async filter(state: DirectionReviewDecision | '', groupId = ''): Promise<void> {
    if (!this.allowLeaveEditor()) return;
    this.stateFilter.set(state); this.groupFilter.set(groupId); this.rows.set(null);
    await this.loadRows();
  }

  allowLeaveEditor(): boolean {
    if (!this.hasUnsavedChoice()) return true;
    this.error.set('Confirma o cancela la elección pendiente antes de continuar.'); return false;
  }
  private invalidateEditor(message: string): void {
    if (this.hasUnsavedChoice()) this.error.set(message);
    this.editor.set(null); this.candidates.set(null); this.candidateDetail.set(null);
    this.candidatesGeneration++; this.detailGeneration++;
    this.candidatesLoading.set(false); this.candidateDetailLoading.set(false);
  }
  private resetGroups(): void {
    this.groupsGeneration++; this.candidatesGeneration++; this.detailGeneration++;
    this.groups.set(null); this.editor.set(null); this.candidates.set(null); this.candidateDetail.set(null); this.anchoredGroup.set(null);
    this.groupsPagination.reset(); this.candidatesPagination.reset(); this.groupsLoading.set(false); this.candidatesLoading.set(false);
  }
  async loadGroups(index = 0, openFirst = false): Promise<void> {
    const review = this.review();
    if (!review || review.state !== 'ready' || this.expired() || !this.matches(review)) return;
    if (index !== this.groupsPagination.index() && !this.allowLeaveEditor()) return;
    const generation = ++this.groupsGeneration; this.groupsLoading.set(true);
    try {
      const request = this.groupsPagination.begin(JSON.stringify([review.id, review.revision, this.rowScope()]), index);
      const page = await this.api.directionConflictGroups(review.workspaceId, review.id, { scope: this.rowScope(), ...(request.cursor ? { cursor: request.cursor } : {}) });
      if (generation !== this.groupsGeneration || !this.matches(review) || this.review()?.revision !== review.revision) return;
      if (page.reviewId !== review.id || page.revision !== review.revision) throw new Error('La revisión cambió. Actualiza los destinos antes de continuar.');
      this.groupsPagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.groups.set(page);
      if (openFirst && !this.editor()) { const group = page.items.find(item => item.state === 'conflicted' || item.state === 'pending'); if (group) await this.openGroup(group, true); }
    } catch (error) { if (generation === this.groupsGeneration && this.matches(review)) this.error.set(errorMessage(error)); }
    finally { if (generation === this.groupsGeneration) this.groupsLoading.set(false); }
  }
  async openGroup(group: DirectionConflictGroupDTO, initial = false): Promise<void> {
    const review = this.review();
    if (!review || !this.allowLeaveEditor() || (!initial && !this.editable())) return;
    const original = group.state === 'omitted' ? null : group.selectedCandidate?.instanceId;
    this.editor.set({ group, revision: review.revision, value: original, original, ...(group.selectedCandidate ? { code: group.selectedCandidate.code } : {}) });
    this.candidates.set(null); this.candidateDetail.set(null); this.candidatesPagination.reset(); this.error.set('');
    await this.loadCandidates();
  }
  async loadCandidates(index = 0): Promise<void> {
    const editor = this.editor(), review = this.review();
    if (!editor || !review || editor.revision !== review.revision || !this.matches(review)) return;
    const generation = ++this.candidatesGeneration; this.candidatesLoading.set(true);
    try {
      const request = this.candidatesPagination.begin(JSON.stringify([review.id, review.revision, editor.group.groupId]), index);
      const page = await this.api.directionConflictCandidates(review.workspaceId, review.id, editor.group.groupId, request.cursor ? { cursor: request.cursor } : {});
      if (generation !== this.candidatesGeneration || this.editor()?.group.groupId !== editor.group.groupId || this.review()?.revision !== review.revision || !this.matches(review)) return;
      if (page.reviewId !== review.id || page.revision !== review.revision || page.group.groupId !== editor.group.groupId) throw new Error('La revisión cambió. Actualiza los destinos antes de continuar.');
      this.candidatesPagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.candidates.set(page);
    } catch (error) { if (generation === this.candidatesGeneration) this.error.set(errorMessage(error)); }
    finally { if (generation === this.candidatesGeneration) this.candidatesLoading.set(false); }
  }
  selectCandidate(value: string | null): void {
    const editor = this.editor(); if (!editor || !this.editable()) return;
    const candidate = value === null ? undefined : this.candidates()?.items.find(row => row.instanceId === value);
    if (value !== null && (!candidate || candidate.availability !== 'selectable')) return;
    this.editor.set({ ...editor, value, code: candidate?.code ?? '' });
    this.error.set('');
  }
  cancelChoice(): void {
    if (this.pending() || this.uncertain()) return;
    this.editor.set(null); this.candidates.set(null); this.candidateDetail.set(null); this.candidatesGeneration++; this.detailGeneration++; this.error.set('');
    if (this.staleEditor()) { this.staleEditor.set(false); void this.recover(); }
  }
  async confirmChoice(): Promise<boolean> {
    const editor = this.editor(), review = this.review();
    if (!editor || !review || editor.value === undefined || !this.hasUnsavedChoice() || !this.editable() || editor.revision !== review.revision) return false;
    this.confirmingGroupId = editor.group.groupId; this.anchoredGroup.set(editor.group);
    await this.resolveGroup(editor.group.groupId, editor.value);
    this.confirmingGroupId = null;
    if (this.uncertain() || this.review()?.revision === review.revision) return false;
    const latest = this.displayGroups().find(group => group.groupId === editor.group.groupId);
    if (latest && this.groups()?.items.includes(latest)) this.anchoredGroup.set(latest);
    else if (this.review()?.state === 'ready') {
      const fresh = this.review()!;
      try { const page = await this.api.directionConflictCandidates(fresh.workspaceId, fresh.id, editor.group.groupId);
        if (this.review()?.revision === page.revision && this.matches(fresh)) this.anchoredGroup.set(page.group);
      } catch (error) { this.error.set(errorMessage(error)); }
    }
    return true;
  }
  async showCandidate(instanceId: string): Promise<void> {
    const review = this.review(), editor = this.editor(); if (!review || !editor) return;
    const generation = ++this.detailGeneration; this.candidateDetailLoading.set(true); this.candidateDetail.set(null);
    try { const detail = await this.api.directionConflictCandidate(review.workspaceId, review.id, editor.group.groupId, instanceId);
      if (generation === this.detailGeneration && this.matches(review) && this.review()?.revision === detail.revision && this.editor()?.group.groupId === editor.group.groupId) this.candidateDetail.set(detail);
    } catch (error) { if (generation === this.detailGeneration) this.error.set(errorMessage(error)); }
    finally { if (generation === this.detailGeneration) this.candidateDetailLoading.set(false); }
  }

  async choose(row: DirectionReviewRowDTO, choice: TargetSide | 'omit' | 'suggest'): Promise<void> {
    if (!this.allowLeaveEditor()) return;
    if (!row.instanceId || row.state === 'excluded' || row.state === 'undetermined' || row.state === 'conflicted') return;
    if ((choice === 'left' || choice === 'right') && !row.options.some(option => option.side === choice)) return;
    await this.edit({op:'set',instanceId:row.instanceId,choice});
  }
  async resolveGroup(groupId: string, winnerInstanceId: string | null): Promise<void> {
    if (!this.displayGroups().some(group => group.groupId === groupId)) return;
    await this.edit({op:'resolveGroup',groupId,winnerInstanceId});
  }
  async omitAll(): Promise<void> { if (this.allowLeaveEditor()) await this.edit({op:'omitAll'}); }
  private async edit(operation: DirectionReviewOperationDTO): Promise<void> {
    const review = this.review(), etag = this.session.etag();
    if (!review || !etag || !this.editable()) return;
    await this.send({kind:'edit',id:review.id,workspaceId:review.workspaceId,etag,
      body:{expectedRevision:review.revision,mutationId:crypto.randomUUID(),operations:[operation]}});
  }

 private async prepare():Promise<void>{const s=this.state(),etag=this.session.etag();if(!s?.compatibleRun||!etag||this.uncertain()||this.pending())return;
 await this.send({kind:'prepare',workspaceId:s.workspaceId,etag,key:crypto.randomUUID(),body:{baseVersionId:s.currentVersionId,validationBasisId:s.validationBasisId,runId:s.compatibleRun.id}});}
 async retry():Promise<void>{
  const attempt=this.attempt;if(!attempt||!this.uncertain()||this.pending())return;
  const operation=attempt.kind==='edit'?attempt.body.operations[0]:undefined;
  const groupId=operation?.op==='resolveGroup'?operation.groupId:undefined;
  if(groupId&&this.editor()?.group.groupId===groupId)this.confirmingGroupId=groupId;
  try{await this.send(attempt);const review=this.review();if(groupId&&review&&!this.uncertain()){
    const page=await this.api.directionConflictCandidates(review.workspaceId,review.id,groupId);
    if(this.matches(review)&&page.revision===this.review()?.revision)this.anchoredGroup.set(page.group);
  }}finally{this.confirmingGroupId=null;}
 }
 private async send(attempt:Attempt):Promise<void>{
  if(!this.owns(attempt.workspaceId))return;this.attempt=attempt;this.pending.set(true);this.error.set('');
  try{if(attempt.kind==='edit'){const reply=await this.api.editDirectionReview(attempt.workspaceId,attempt.id,attempt.body,attempt.etag);if(this.attempt!==attempt||!this.owns(attempt.workspaceId))return;this.attempt=null;this.uncertain.set(false);await this.acceptSummary(reply.summary);}
   else{const job=await this.api.prepareDirectionReview(attempt.workspaceId,attempt.body,attempt.etag,attempt.key);if(this.attempt!==attempt||!this.owns(attempt.workspaceId))return;this.attempt=null;this.uncertain.set(false);this.track(job,job.resultRef?.id);}
  }catch(e){if(this.attempt!==attempt||!this.owns(attempt.workspaceId))return;this.error.set(errorMessage(e));const uncertain=e instanceof HttpErrorResponse&&(e.status===0||e.status>=500);this.uncertain.set(uncertain);
   if(!uncertain)this.attempt=null;if(e instanceof HttpErrorResponse&&e.status===412)await this.session.refreshWorkspace(attempt.workspaceId);
   if(!this.hasUnsavedChoice())await this.recover(false);
  }finally{if(this.owns(attempt.workspaceId))this.pending.set(false);}
 }
 private track(job:JobDTO,reviewId?:string):void{this.observedJob={jobId:job.jobId,...(reviewId?{reviewId}:{})};this.session.trackJob(job);}
 private async finishJob(job:JobDTO):Promise<void>{if(job.status!=='succeeded')this.error.set(job.diagnostics[0]?.message??'No se pudieron preparar las decisiones. Vuelve a intentarlo.');await this.recover(false);}
 async discard():Promise<void>{if(!this.allowLeaveEditor())return;const r=this.review(),etag=this.session.etag();if(!r||!etag||this.busy()||this.uncertain())return;this.pending.set(true);
 try{await this.api.discardDirectionReview(r.workspaceId,r.id,etag);if(this.owns(r.workspaceId)){this.resetGroups();this.review.set(null);this.rows.set(null);await this.recover(false);}}
 catch(e){this.error.set(errorMessage(e));}finally{this.pending.set(false);}}
}
