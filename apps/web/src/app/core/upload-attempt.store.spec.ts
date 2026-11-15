import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_CONFIG, parseConnectionConfig } from './connection-config';
import { UploadAttemptStore } from './upload-attempt.store';
const id='00000000-0000-4000-8000-000000000005',attempt={workspaceId:id,baseVersionId:null,etag:'"empty"',fingerprint:'a'.repeat(64),createKey:id,sealKey:id};
function store(profile='demo-public'){TestBed.configureTestingModule({providers:[{provide:CONNECTION_CONFIG,useValue:parseConnectionConfig({apiBaseUrl:'https://api.example.test',deploymentProfile:profile},'https://web.example.test')}]});return TestBed.inject(UploadAttemptStore);}
afterEach(()=>{TestBed.resetTestingModule();sessionStorage.clear();});
describe('upload recovery identities',()=>{
 it('retains only IDs, fingerprints and original CAS across reload',()=>{store().save({...attempt,batchId:id,sealJobId:id,inspectionKey:id,contextHash:'b'.repeat(64)});TestBed.resetTestingModule();expect(store().get(id)).toEqual({...attempt,batchId:id,sealJobId:id,inspectionKey:id,contextHash:'b'.repeat(64)});});
 it('rejects business fields and keeps other profiles untouched when cleared',()=>{const first=store();first.save(attempt);for(const extra of [{name:'private.xlsx'},{rules:[]},{context:{entityId:'PRIVATE'}},{bytes:'excel'},{providerUrl:'https://blob.example'}])expect(()=>first.save({...attempt,...extra} as any)).toThrow();TestBed.resetTestingModule();const second=store('preview');expect(second.get(id)).toBeNull();second.save(attempt);second.clearAll();TestBed.resetTestingModule();expect(store().get(id)).toEqual(attempt);});
});
