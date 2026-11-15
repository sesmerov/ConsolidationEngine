import { inject, Injectable, signal } from '@angular/core';
import { CONNECTION_CONFIG } from './connection-config';
export interface UploadAttempt {
 readonly workspaceId:string;readonly baseVersionId:string|null;readonly etag:string;readonly fingerprint:string;
 readonly createKey:string;readonly sealKey:string;readonly batchId?:string;readonly sealJobId?:string;
 readonly inspectionKey?:string;readonly contextHash?:string;readonly inspectionJobId?:string;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,hash=/^[0-9a-f]{64}$/;
function valid(input:unknown):input is UploadAttempt{
 if(!input||typeof input!=='object'||Array.isArray(input))return false;const value=input as Record<string,unknown>;
 const ids=['workspaceId','createKey','sealKey'],optional=['batchId','sealJobId','inspectionKey','inspectionJobId'];
 return Object.keys(value).every(key=>[...ids,...optional,'baseVersionId','etag','fingerprint','contextHash'].includes(key))&&ids.every(key=>typeof value[key]==='string'&&uuid.test(value[key]))&&optional.every(key=>value[key]===undefined||typeof value[key]==='string'&&uuid.test(value[key]))&&(value['baseVersionId']===null||typeof value['baseVersionId']==='string'&&uuid.test(value['baseVersionId']))&&typeof value['etag']==='string'&&value['etag'].length>0&&value['etag'].length<=1024&&typeof value['fingerprint']==='string'&&hash.test(value['fingerprint'])&&(value['contextHash']===undefined||typeof value['contextHash']==='string'&&hash.test(value['contextHash']));
}
/** Recovery identities and digests only. Never file names, cell data, context fields or Excel bytes. */
@Injectable({providedIn:'root'})
export class UploadAttemptStore{
 private readonly prefix='ce.upload-attempt.v1:'+encodeURIComponent(inject(CONNECTION_CONFIG).namespace)+':';
 readonly revision=signal(0);
 get(workspaceId:string):UploadAttempt|null{this.revision();const raw=sessionStorage.getItem(this.prefix+workspaceId);if(!raw)return null;try{const value:unknown=JSON.parse(raw);if(valid(value)&&value.workspaceId===workspaceId)return value;}catch{}sessionStorage.removeItem(this.prefix+workspaceId);return null;}
 save(value:UploadAttempt):void{if(!valid(value))throw new Error('No se pudo conservar una carga recuperable.');sessionStorage.setItem(this.prefix+value.workspaceId,JSON.stringify(value));this.revision.update(value=>value+1);}
 clear(workspaceId:string):void{sessionStorage.removeItem(this.prefix+workspaceId);this.revision.update(value=>value+1);}
 clearAll():void{for(let index=sessionStorage.length-1;index>=0;index--){const key=sessionStorage.key(index);if(key?.startsWith(this.prefix))sessionStorage.removeItem(key);}this.revision.update(value=>value+1);}
}
