import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_CONFIG, parseConnectionConfig, readConnectionConfig } from './connection-config';
import { ApiClient } from './api-client';

describe('public connection configuration',()=>{
  afterEach(()=>{document.getElementById('ce-public-config')?.remove();TestBed.resetTestingModule();});
  it('defaults to the same-origin local API only when configuration is absent',()=>{
    const local=parseConnectionConfig(undefined,'http://127.0.0.1:3318');expect(local.apiBaseUrl).toBe('');expect(local.deploymentProfile).toBe('local');
    expect(local.namespace).toContain('http://127.0.0.1:3318');
  });
  it('normalizes the trusted backend origin and isolates frontend, API and deployment namespaces',()=>{
    const config=parseConnectionConfig({apiBaseUrl:'https://API.example.test/',deploymentProfile:'demo-public'},'https://web.example.test');
    expect(config.apiBaseUrl).toBe('https://api.example.test');
    for(const different of [parseConnectionConfig({apiBaseUrl:config.apiBaseUrl,deploymentProfile:'preview'},'https://web.example.test'),parseConnectionConfig({apiBaseUrl:'https://other.example.test',deploymentProfile:'demo-public'},'https://web.example.test'),parseConnectionConfig({apiBaseUrl:config.apiBaseUrl,deploymentProfile:'demo-public'},'https://preview.example.test')])expect(different.namespace).not.toBe(config.namespace);
  });
  it.each(['https://api.example.test/api/v1','https://user:password@api.example.test','https://api.example.test?token=x','https://api.example.test#secret','http://external.example.test','javascript:alert(1)','//api.example.test'])('rejects an invalid API origin without repairing it: %s',apiBaseUrl=>{
    expect(()=>parseConnectionConfig({apiBaseUrl,deploymentProfile:'demo-public'},'https://web.example.test')).toThrow();
  });
  it('allows loopback HTTP for the real local cross-origin hosted harness',()=>{
    expect(parseConnectionConfig({apiBaseUrl:'http://127.0.0.1:4321',deploymentProfile:'hosted-test'},'http://127.0.0.1:4320').apiBaseUrl).toBe('http://127.0.0.1:4321');
  });
  it('reads only the inert JSON node and reports malformed or secret-bearing configuration as invalid',()=>{
    const node=document.createElement('script');node.id='ce-public-config';node.type='application/json';node.textContent=JSON.stringify({apiBaseUrl:'https://api.example.test',deploymentProfile:'demo-public'});document.head.append(node);
    expect(readConnectionConfig(document,'https://web.example.test').apiBaseUrl).toBe('https://api.example.test');
    node.textContent='{broken';expect(readConnectionConfig(document,'https://web.example.test').error).toBeTruthy();
    node.textContent=JSON.stringify({apiBaseUrl:'https://api.example.test',deploymentProfile:'demo-public',BLOB_READ_WRITE_TOKEN:'never-print'});
    const invalid=readConnectionConfig(document,'https://web.example.test');expect(invalid.error).toBeTruthy();expect(JSON.stringify(invalid)).not.toContain('never-print');
  });
  it('prefixes every API path once, keeps bearer headers and never enables cross-origin cookies',async()=>{
    const config=parseConnectionConfig({apiBaseUrl:'https://api.example.test/',deploymentProfile:'demo-public'},'https://web.example.test');
    TestBed.configureTestingModule({providers:[provideHttpClient(),provideHttpClientTesting(),{provide:CONNECTION_CONFIG,useValue:config}]});
    const api=TestBed.inject(ApiClient),http=TestBed.inject(HttpTestingController);api.setSessionToken('private-test-bearer');
    const bootstrap=api.bootstrap(),first=http.expectOne('https://api.example.test/api/v1/bootstrap');expect(first.request.headers.has('X-CE-Session')).toBe(false);expect(first.request.withCredentials).toBe(false);first.flush({mode:'hosted',apiVersion:'v1',limits:{}});await bootstrap;
    const workspace=api.workspace('work space'),second=http.expectOne('https://api.example.test/api/v1/workspaces/work%20space?compact=true');expect(second.request.headers.get('X-CE-Session')).toBe('private-test-bearer');expect(second.request.withCredentials).toBe(false);second.flush({},{headers:{ETag:'"v"'}});await workspace;http.verify();
  });
});
