import type { JobDTO, JsonValue, Snapshot, UUID, WorkspaceDTO } from '@ce/contracts';

/** Every adapter must include this owner in its query, not authorize after loading. */
export interface WorkspaceOwner { readonly sessionId: UUID; readonly workspaceId: UUID }
export type WorkspaceMetadata = Pick<WorkspaceDTO, 'id' | 'name' | 'state' | 'currentVersionId' | 'validationBasisId' | 'activeJobId' | 'counts' | 'sessionBytes'> & { readonly etag: string };
export type VersionMetadata = Omit<Snapshot, 'content'>;

/** Asynchronous boundary suitable for persistent adapters; it is not a synchronous Map facade.
 * Publication is an explicit domain transaction, not a callback serialized by this read port.
 */
export interface WorkspaceRepository {
  workspace(owner: WorkspaceOwner): Promise<WorkspaceMetadata>;
  version(owner: WorkspaceOwner, versionId: UUID): Promise<VersionMetadata>;
  job(owner: WorkspaceOwner, jobId: UUID): Promise<JobDTO>;
  /** Internal server-generated key already authorized by its domain caller, never a browser key.
   * Hosted public projections use owner-qualified bounded indexed queries separately.
   */
  record(owner: WorkspaceOwner, key: string): Promise<JsonValue | undefined>;
  /** Worker hydration only; public read routes must use metadata and bounded projections. */
  loadSnapshot(owner: WorkspaceOwner, versionId: UUID): Promise<Snapshot>;
}
