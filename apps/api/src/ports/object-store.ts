import type { UUID } from '@ce/contracts';
import type { WorkspaceOwner } from './workspace-repository.js';

export const MAX_PRIVATE_OBJECT_PART_BYTES = 3 * 1024 * 1024;
export interface PrivateObjectReference { readonly objectId: UUID; readonly byteLength: number; readonly sha256: string }
/** Private binary object parts. No provider key, URL or filesystem path crosses this port. */
export interface ObjectStore {
  put(owner: WorkspaceOwner, bytes: Uint8Array): Promise<PrivateObjectReference>;
  get(owner: WorkspaceOwner, reference: PrivateObjectReference): Promise<Uint8Array>;
  remove(owner: WorkspaceOwner, objectId: UUID): Promise<void>;
}
