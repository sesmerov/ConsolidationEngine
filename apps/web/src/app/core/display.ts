import type { WorkspaceDTO } from '@ce/contracts';
/** Civil dates have no timezone: do not turn a reference date into a Date instant. */
export function civilDate(value: string): string { const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); return parts ? `${parts[3]}/${parts[2]}/${parts[1]}` : value; }
export function versionLabel(workspace: WorkspaceDTO | null, id: string | null | undefined): string {
  const index = id ? workspace?.versionIds.indexOf(id) ?? -1 : -1; return index >= 0 ? 'Versión ' + (index + 1) : id ? 'Versión histórica' : 'Sin versión';
}
