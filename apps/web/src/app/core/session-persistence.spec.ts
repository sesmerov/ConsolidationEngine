import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_CONFIG, parseConnectionConfig } from './connection-config';
import { SessionPersistence } from './session-persistence';
const id='70000000-0000-4000-8000-000000000001';
function create(profile='demo-public'){
  TestBed.configureTestingModule({providers:[{provide:CONNECTION_CONFIG,useValue:parseConnectionConfig({apiBaseUrl:'https://api.example.test',deploymentProfile:profile},'https://web.example.test')}]});
  return TestBed.inject(SessionPersistence);
}
describe('minimal anonymous-session recovery',()=>{
  beforeEach(()=>sessionStorage.clear());afterEach(()=>{vi.restoreAllMocks();TestBed.resetTestingModule();sessionStorage.clear();});
  it('does not create authority merely by reading and persists two distinct WebCrypto secrets before returning them',()=>{
    const storage=create();expect(storage.load()).toBeNull();expect(sessionStorage.length).toBe(0);
    const record=storage.prepare();expect(record.token).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);expect(record.creationNonce).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);expect(record.token).not.toBe(record.creationNonce);
    expect(storage.load()).toEqual(record);expect(storage.prepare()).toEqual(record);
  });
  it('recovers exactly the same pair and minimal selected identities after reloading the same tab',()=>{
    const storage=create(),record=storage.prepare();storage.save({...record,sessionId:id,workspaceId:id,stage:'preview',contextId:'corep',previewId:id,closeKey:id});
    TestBed.resetTestingModule();expect(create().load()).toEqual({...record,sessionId:id,workspaceId:id,stage:'preview',contextId:'corep',previewId:id,closeKey:id});
  });
  it('isolates deployments and clears only its own session record',()=>{
    const record=create().prepare();TestBed.resetTestingModule();const preview=create('preview');expect(preview.load()).toBeNull();preview.prepare();preview.clear();sessionStorage.setItem('another-app','keep');
    TestBed.resetTestingModule();const original=create();expect(original.load()).toEqual(record);original.clear();expect(sessionStorage.getItem('another-app')).toBe('keep');
  });
  it('rejects private business content, provider secrets, invalid IDs and unexpected record keys',()=>{
    const storage=create(),record=storage.prepare();
    for(const extra of [{facts:[]},{rules:'1=1'},{file:new Blob(['private'])},{providerToken:'no'},{workspaceId:'not-uuid'},{stage:'untrusted-route'}])expect(()=>storage.save({...record,...extra} as any)).toThrow();
    expect(storage.load()).toEqual(record);
  });
  it('does not promise recovery when the browser refuses persistence',()=>{
    const storage=create();vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Quota','QuotaExceededError');});expect(()=>storage.prepare()).toThrow();
  });
});
