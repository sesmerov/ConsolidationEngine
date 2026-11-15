import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { HttpResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { CompactWorkspaceDTO, DemoSessionDTO, JobDTO, ReportContext, WorkspaceDTO } from '@ce/contracts';
import { ApiClient } from './api-client';
import { OperationAttemptStore } from './operation-attempt.store';
import { SessionPersistence } from './session-persistence';
import { CONNECTION_CONFIG } from './connection-config';
import type { SessionRecoveryRecord } from './session-persistence';
import { UploadAttemptStore } from './upload-attempt.store';
import { CursorPage } from './cursor-page';
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(ApiClient);
  private readonly attempts = inject(OperationAttemptStore);
  private readonly uploads=inject(UploadAttemptStore);
  private readonly persistence = inject(SessionPersistence);
  private readonly connection = inject(CONNECTION_CONFIG);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer:ReturnType<typeof setTimeout>|undefined;
  private activityTimer:ReturnType<typeof setTimeout>|undefined;
  private expiryCheck=false;
  private metadataReadAt=0;
  private generation = 0;
  readonly hosted=signal(this.connection.deploymentProfile!=='local');
  readonly metadata=signal<DemoSessionDTO|null>(null);
  readonly expiryWarning=signal(false);
  readonly connected = signal(false);
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  /** contexts contains the currently loaded page and, if needed, the retained selected row. */
  readonly workspace = signal<(WorkspaceDTO & {contextCount?:number}) | null>(null);
  readonly contextCount=computed(()=>this.workspace()?.contextCount??this.workspace()?.contexts.length??0);
  readonly contextsLoading=signal(false);
  readonly contextsCursor=signal<string|null>(null);
  readonly contextPagination=new CursorPage();
  private contextGeneration=0;
  readonly etag = signal<string | null>(null);
  readonly job = signal<JobDTO | null>(null);
  readonly selectedContextId = signal<string | null>(null);
  readonly selectedExportVersionId = signal<string | null>(null);
  readonly versionId = computed(() => this.workspace()?.currentVersionId ?? null);
  readonly validationBasisId = computed(() => this.workspace()?.validationBasisId ?? null);
  readonly exportVersionId = computed(() => { const selected = this.selectedExportVersionId(); return selected && this.workspace()?.versionIds.includes(selected) ? selected : this.versionId(); });
  readonly selectedContext = computed(() => this.workspace()?.contexts.find((context) => context.contextId === this.selectedContextId()) ?? null);
  readonly jobActive = computed(() => { const job = this.job(); return job ? !isTerminalJob(job.status) : false; });
  constructor() {
    const ended=this.api.sessionEnded?.subscribe(error=>this.report(error));
    const accepted=this.api.actionAccepted?.subscribe(()=>this.scheduleMetadataRefresh());
    inject(DestroyRef).onDestroy(()=>{this.stopPolling();this.clearSessionTimers();ended?.unsubscribe();accepted?.unsubscribe();});
  }
  async connect(): Promise<void> {
    this.stopPolling();
    await this.perform(async () => {
      const bootstrap = await this.api.bootstrap();
      if('mode' in bootstrap && bootstrap.mode==='hosted'){
        this.hosted.set(true);const saved=this.persistence.load();
        if(!saved){this.connected.set(false);this.resetWorkspace();return;}
        this.api.setSessionToken(saved.token);
        if(saved.closeKey){await this.api.revokeDemoSession(saved.closeKey);this.endSession();return;}
        await this.acceptSession(saved.sessionId?await this.api.demoSession():await this.api.createDemoSession(saved.creationNonce));
        return;
      }
      if(!('sessionToken' in bootstrap))throw new Error('Respuesta de conexión inválida.');
      this.hosted.set(false);this.api.setSessionToken(bootstrap.sessionToken);this.connected.set(true);
      if (bootstrap.activeWorkspaceId) await this.refreshWorkspace(bootstrap.activeWorkspaceId);
      else { this.attempts.clearAll();this.uploads.clearAll(); this.resetWorkspace(); }
    });
  }
  async startDemo():Promise<void>{
    if(this.pending()||this.connected()||!this.hosted())return;
    await this.perform(async()=>{const saved=this.persistence.prepare();this.api.setSessionToken(saved.token);
      if(saved.closeKey){await this.api.revokeDemoSession(saved.closeKey);this.endSession();return;}
      await this.acceptSession(saved.sessionId?await this.api.demoSession():await this.api.createDemoSession(saved.creationNonce));});
  }
  async create(name: string): Promise<void> { await this.perform(async () => {
    let key:string|undefined;
    if(this.hosted()){
      const saved=this.persistence.load();if(!saved?.sessionId||!this.connected())throw new Error('Inicia una sesión de demo antes de crear el conjunto.');
      key=saved.workspaceCreateKey??crypto.randomUUID();this.persistence.save({...saved,workspaceCreateKey:key});
    }
    await this.acceptWorkspace(await this.api.createWorkspace(name,key));
    if(this.hosted()){const saved=this.persistence.load();if(saved){const {workspaceCreateKey:_,...record}=saved;this.persistence.save({...record,workspaceId:this.workspace()!.id});}}
  }); }
  async close(): Promise<void> {
    if(this.hosted()){
      await this.perform(async()=>{const saved=this.persistence.load();if(!saved){this.endSession();return;}
        const key=saved.closeKey??crypto.randomUUID();this.persistence.save({...saved,closeKey:key});this.connected.set(false);this.stopPolling();this.clearSessionTimers();await this.api.revokeDemoSession(key);this.endSession();});return;
    }
    const workspace = this.workspace(); const etag = this.etag(); if (!workspace || !etag) return;
    await this.perform(async () => {
      await this.api.closeWorkspace(workspace.id, etag); this.attempts.clearAll();this.uploads.clearAll(); this.stopPolling(); this.resetWorkspace();
    });
  }
  async refreshWorkspace(id = this.workspace()?.id): Promise<void> {
    if (!id) return;
    const generation = this.generation;
    const response = await this.api.workspace(id); if (generation !== this.generation) return; await this.acceptWorkspace(response);
    const active = response.body?.activeJobId;
    if (active) { const job = await this.api.job(id, active); if (generation === this.generation) this.trackJob(job); }
  }
  selectContext(id: string): void {
    if (this.workspace()?.contexts.some((context) => context.contextId === id)) {this.selectedContextId.set(id);this.rememberView({contextId:id});}
  }
  selectExportVersion(id: string): void { if (this.workspace()?.versionIds.includes(id)) {this.selectedExportVersionId.set(id);this.rememberView({versionId:id});} }
  recoveryView():SessionRecoveryRecord|null{if(!this.hosted())return null;const record=this.persistence.load();return record?.workspaceId===this.workspace()?.id?record:null;}
  rememberView(value:Pick<SessionRecoveryRecord,'contextId'|'stage'|'runId'|'previewId'|'versionId'>):void{
    if(!this.hosted()||!this.connected())return;const record=this.persistence.load(),workspaceId=this.workspace()?.id;if(record&&workspaceId)this.persistence.save({...record,workspaceId,...value});
  }
  trackJob(job: JobDTO): void {
    this.stopPolling(); this.job.set(job);
    if (!isTerminalJob(job.status)) this.schedule(this.generation);
  }
  async cancelJob(): Promise<void> {
    const job = this.job(); if (!job) return;
    await this.perform(async () => { const result = await this.api.cancelJob(job.workspaceId, job.jobId); this.trackJob(result); await this.refreshWorkspace(job.workspaceId); });
  }
  private async acceptWorkspace(response: HttpResponse<WorkspaceDTO|CompactWorkspaceDTO>): Promise<void> {
    if (!response.body || !response.headers.get('ETag')) throw new Error('Invalid workspace response');
    if (this.workspace()?.id !== response.body.id || this.selectedExportVersionId() && !response.body.versionIds.includes(this.selectedExportVersionId()!)) this.selectedExportVersionId.set(null);
    const current=this.workspace(),body=response.body,compact=!('contexts' in body);
    this.workspace.set(compact?{...body,contexts:current?.id===body.id&&current.currentVersionId===body.currentVersionId?current.contexts:[]}:body); this.etag.set(response.headers.get('ETag'));
    const saved=this.recoveryView();
    if(!this.selectedContextId()&&saved?.contextId)this.selectedContextId.set(saved.contextId);
    if(!this.selectedExportVersionId()&&saved?.versionId&&body.versionIds.includes(saved.versionId))this.selectedExportVersionId.set(saved.versionId);
    if(compact){if(body.contextCount>0&&(!current||current.id!==body.id||current.currentVersionId!==body.currentVersionId||!current.contexts.length))await this.loadContexts();else if(body.contextCount===0){this.selectedContextId.set(null);this.contextsCursor.set(null);}}
    else if (!body.contexts.some((context) => context.contextId === this.selectedContextId())) this.selectedContextId.set(body.contexts[0]?.contextId ?? null);
  }
  async loadContexts(index:number|boolean=0):Promise<void>{
    const workspace=this.workspace();if(!workspace?.currentVersionId||this.contextsLoading())return;
    const nextIndex=typeof index==='boolean'?(index?this.contextPagination.index()+1:0):index;
    const request=this.contextPagination.begin(JSON.stringify([workspace.id,workspace.currentVersionId]),nextIndex),cursor=request.cursor;
    const generation=++this.contextGeneration;this.contextsLoading.set(true);
    const current=()=>generation===this.contextGeneration&&this.workspace()?.id===workspace.id&&this.versionId()===workspace.currentVersionId;
    try{const page=await this.api.contexts(workspace.id,cursor?{cursor}:{});if(!current())return;
      if(page.workspaceId!==workspace.id||page.versionId!==workspace.currentVersionId||page.items.length>50)throw new Error('Respuesta de contextos incompatible.');
      const contexts=await Promise.all(page.items.map(item=>'valueRef' in item?this.api.largeValue<ReportContext>(workspace.id,item):Promise.resolve(item)));if(!current())return;
      const selected=this.selectedContextId();let retained=workspace.contexts.find(context=>context.contextId===selected);
      if(selected&&!retained&&!contexts.some(context=>context.contextId===selected)){
        const selectedPage=await this.api.contexts(workspace.id,{contextId:selected});if(!current())return;
        const found=selectedPage.items[0];retained=found?('valueRef' in found?await this.api.largeValue<ReportContext>(workspace.id,found):found):undefined;
        if(retained?.contextId!==selected)retained=undefined;
      }
      if(!current())return;const visible=retained&&!contexts.some(context=>context.contextId===retained!.contextId)?[retained,...contexts]:contexts;
      this.contextPagination.accept(request.index,page.total,page.nextCursor,page.items.length);
      this.workspace.update(value=>value?{...value,contexts:visible,contextCount:page.total}:value);this.contextsCursor.set(page.nextCursor);
      if(!visible.some(context=>context.contextId===selected))this.selectedContextId.set(visible[0]?.contextId??null);
    }catch(error){if(current())this.report(error);}finally{if(generation===this.contextGeneration)this.contextsLoading.set(false);}
  }
  private schedule(generation: number): void {
    this.timer = setTimeout(() => { void this.poll(generation); }, Math.max(this.hosted()?5000:250, this.job()?.pollAfterMs ?? 1000));
  }
  private async poll(generation: number): Promise<void> {
    const job = this.job(); if (!job || generation !== this.generation) return;
    try {
      const current = await this.api.job(job.workspaceId, job.jobId);
      if (generation !== this.generation) return;
      this.job.set(current);
      if (isTerminalJob(current.status)) await this.refreshWorkspace(job.workspaceId); else this.schedule(generation);
    } catch (error) { if (generation === this.generation) {
      if(this.hosted()&&this.connected()&&error instanceof HttpErrorResponse&&(error.status===0||error.status>=500)){
        this.error.set('La conexión se ha interrumpido. Se volverá a consultar el mismo trabajo.');this.timer=setTimeout(()=>void this.poll(generation),10000);
      }else{this.stopPolling();this.report(error);}
    } }
  }
  private async acceptSession(metadata:DemoSessionDTO):Promise<void>{
    if(metadata.state!=='active'){this.endSession();this.error.set('Esta sesión ha terminado. Inicia una demo nueva para continuar.');return;}
    const saved=this.persistence.load();if(!saved)throw new Error('No se conservó la identidad de la sesión.');
    const {workspaceId:_oldWorkspace,...record}=saved;
    this.persistence.save({...record,sessionId:metadata.id,...(metadata.activeWorkspaceId?{workspaceId:metadata.activeWorkspaceId}:{})});
    this.metadata.set(metadata);this.metadataReadAt=Date.now();this.connected.set(true);this.planExpiry(metadata);
    if(metadata.activeWorkspaceId)await this.refreshWorkspace(metadata.activeWorkspaceId);else this.resetWorkspace();
  }
  private scheduleMetadataRefresh():void{
    if(!this.hosted()||!this.connected()||this.activityTimer)return;
    // Successful user work renews the server lease; this read merely displays its deadline.
    const delay=Math.max(300,30000-(Date.now()-this.metadataReadAt));
    this.activityTimer=setTimeout(()=>{this.activityTimer=undefined;if(this.connected())void this.refreshMetadata();},delay);
  }
  private async refreshMetadata():Promise<void>{
    if(!this.hosted()||!this.connected())return;
    try{const metadata=await this.api.demoSession();if(!this.connected())return;
      if(metadata.state!=='active'){this.endSession();this.error.set('Esta sesión ha terminado. Puedes iniciar una demo nueva.');return;}
      this.metadata.set(metadata);this.metadataReadAt=Date.now();this.planExpiry(metadata);
    }catch(error){this.report(error);}
  }
  private planExpiry(metadata:DemoSessionDTO):void{
    clearTimeout(this.expiryTimer);const remaining=Math.min(Date.parse(metadata.expiresAt),Date.parse(metadata.absoluteExpiresAt))-Date.now();
    this.expiryWarning.set(remaining<=10*60000);this.expiryCheck=false;
    if(remaining>10*60000)this.expiryTimer=setTimeout(()=>{this.expiryWarning.set(true);this.expiryTimer=setTimeout(()=>this.checkExpiry(),10*60000);},remaining-10*60000);
    else if(remaining>0)this.expiryTimer=setTimeout(()=>this.checkExpiry(),remaining);
  }
  private checkExpiry():void{if(this.expiryCheck)return;this.expiryCheck=true;void this.refreshMetadata();}
  private clearSessionTimers():void{clearTimeout(this.expiryTimer);clearTimeout(this.activityTimer);this.expiryTimer=undefined;this.activityTimer=undefined;this.expiryWarning.set(false);}
  private resetWorkspace():void{this.contextGeneration++;this.contextPagination.reset();this.contextsLoading.set(false);this.contextsCursor.set(null);this.workspace.set(null);this.etag.set(null);this.job.set(null);this.selectedContextId.set(null);this.selectedExportVersionId.set(null);}
  private endSession():void{this.connected.set(false);this.api.clearSession();this.stopPolling();this.clearSessionTimers();this.attempts.clearAll();this.uploads.clearAll();this.persistence.clear();this.metadata.set(null);this.resetWorkspace();}
  private stopPolling(): void { this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async perform(action: () => Promise<void>): Promise<void> {
    this.pending.set(true); this.error.set(null);
    try { await action(); } catch (error) { this.report(error); } finally { this.pending.set(false); }
  }
  private report(error: unknown): void {
    if (error instanceof HttpErrorResponse && (error.status === 401 || ['SESSION_UNAUTHENTICATED','INVALID_SESSION','SESSION_EXPIRED','SESSION_REVOKED'].includes(String(error.error?.error?.code)))) this.endSession();
    const message = error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : this.hosted()?'No se pudo confirmar la conexión. Reintenta para recuperar la misma sesión.':'No se pudo conectar con la sesión local. Comprueba que el servidor siga abierto.';
    this.error.set(message);
  }
}
