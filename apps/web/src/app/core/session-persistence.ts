import { inject, Injectable } from '@angular/core';
import { CONNECTION_CONFIG } from './connection-config';

export interface SessionRecoveryRecord {
  readonly token:string;readonly creationNonce:string;
  readonly sessionId?:string;readonly workspaceId?:string;readonly contextId?:string;
  readonly stage?:'import'|'validation'|'preview'|'exports';
  readonly runId?:string;readonly previewId?:string;readonly versionId?:string;readonly closeKey?:string;readonly workspaceCreateKey?:string;
}
const secret=/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function valid(value:unknown):value is SessionRecoveryRecord{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;const r=value as Record<string,unknown>;
  if(typeof r['token']!=='string'||!secret.test(r['token'])||typeof r['creationNonce']!=='string'||!secret.test(r['creationNonce']))return false;
  if(Object.keys(r).some(key=>!['token','creationNonce','sessionId','workspaceId','contextId','stage','runId','previewId','versionId','closeKey','workspaceCreateKey'].includes(key)))return false;
  if(['sessionId','workspaceId','runId','previewId','versionId','closeKey','workspaceCreateKey'].some(key=>Object.hasOwn(r,key)&&(typeof r[key]!=='string'||!uuid.test(r[key]))))return false;
  if(Object.hasOwn(r,'contextId')&&(typeof r['contextId']!=='string'||r['contextId'].length<1||r['contextId'].length>512))return false;
  return !Object.hasOwn(r,'stage')||['import','validation','preview','exports'].includes(String(r['stage']));
}
function randomSecret():string{
  if(!globalThis.crypto?.getRandomValues)throw new Error('El navegador necesita una conexión segura para iniciar la demo.');
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
/** Only the browser bearer, its creation nonce and minimal recovery identities belong here. */
@Injectable({providedIn:'root'})
export class SessionPersistence{
  private readonly key='ce.demo-session.v1:'+encodeURIComponent(inject(CONNECTION_CONFIG).namespace);
  load():SessionRecoveryRecord|null{
    const raw=sessionStorage.getItem(this.key);if(!raw)return null;
    try{const record:unknown=JSON.parse(raw);if(valid(record))return record;}catch{/* Invalid records cannot become credentials. */}
    sessionStorage.removeItem(this.key);return null;
  }
  prepare():SessionRecoveryRecord{const existing=this.load();if(existing)return existing;const record={token:randomSecret(),creationNonce:randomSecret()};this.save(record);return record;}
  save(record:SessionRecoveryRecord):void{if(!valid(record))throw new Error('No se puede conservar una identidad de sesión inválida.');sessionStorage.setItem(this.key,JSON.stringify(record));}
  clear():void{sessionStorage.removeItem(this.key);}
}
