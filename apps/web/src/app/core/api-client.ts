import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import type { HttpResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { BootstrapDTO, JobDTO, WorkspaceDTO } from '@ce/contracts';
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
  private jobUrl(workspaceId: string, jobId: string): string {
    return '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/jobs/' + encodeURIComponent(jobId);
  }
}
