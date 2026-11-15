import { InjectionToken } from '@angular/core';

export interface ConnectionConfig {
  readonly apiBaseUrl: string;
  readonly deploymentProfile: string;
  readonly frontendOrigin: string;
  readonly namespace: string;
  readonly error?: string;
}
const invalid = 'La configuración de conexión no es válida. Revisa la dirección pública del servidor.';
export function parseConnectionConfig(input: unknown, frontendOrigin: string): ConnectionConfig {
  let apiBaseUrl='', deploymentProfile='local';
  if(input!==undefined){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error(invalid);
    const record=input as Record<string,unknown>;
    if(Object.keys(record).length!==2||typeof record['apiBaseUrl']!=='string'||typeof record['deploymentProfile']!=='string'||!/^[a-z0-9][a-z0-9-]{0,99}$/.test(record['deploymentProfile']))throw new Error(invalid);
    deploymentProfile=record['deploymentProfile'];const raw=record['apiBaseUrl'];
    if(raw){
      let url:URL;try{url=new URL(raw);}catch{throw new Error(invalid);}
      const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
      if(!/^https?:\/\//.test(raw)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback)))throw new Error(invalid);
      apiBaseUrl=url.origin;
    }else if(deploymentProfile!=='local')throw new Error(invalid);
  }
  return Object.freeze({apiBaseUrl,deploymentProfile,frontendOrigin,namespace:JSON.stringify([frontendOrigin,apiBaseUrl||frontendOrigin,deploymentProfile])});
}
/** A malformed present configuration never silently falls back to a different backend. */
export function readConnectionConfig(document: Document, frontendOrigin: string): ConnectionConfig {
  const node=document.getElementById('ce-public-config');
  try{
    if(node&&node.getAttribute('type')!=='application/json')throw new Error(invalid);
    return parseConnectionConfig(node?JSON.parse(node.textContent??''):undefined,frontendOrigin);
  }catch{return Object.freeze({...parseConnectionConfig(undefined,frontendOrigin),error:invalid});}
}
export const CONNECTION_CONFIG=new InjectionToken<ConnectionConfig>('CE public connection',{
  providedIn:'root',factory:()=>readConnectionConfig(document,location.origin),
});
