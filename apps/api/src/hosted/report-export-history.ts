import type { ApplicationBundle, Snapshot } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { sourceSignature, unavailable, type ReportExportHistory, type ReportHistoryVersion } from '../export/change-log.js';
import type { CanonicalCodec, CanonicalRef } from './canonical-codec.js';
import type { HostedDatabase } from './database.js';
import { assertClaimAuthority, type HostedJobClaim } from './job-coordinator.js';

/** Only the export target is hydrated. Ancestors contribute at most 21 source identities and their application log. */
export async function readReportExportHistory(claim: HostedJobClaim, target: Snapshot,
  deps: { db: HostedDatabase; codec: CanonicalCodec; now?: () => number }, cancelled: () => boolean): Promise<ReportExportHistory> {
  const chain = new Map<string, ReportHistoryVersion>(), applications: ApplicationBundle[] = [], signature = sourceSignature(target.content.sources);
  let versionId: string | undefined = target.versionId;
  while (versionId) {
    if (cancelled()) throw new ApiError('JOB_TIMED_OUT');
    if (chain.size >= 20 || chain.has(versionId)) return unavailable('INCOMPLETE_VERSION_HISTORY');
    const currentId = versionId;
    const metadata = await deps.db.transaction(async tx => {
      await assertClaimAuthority(tx, claim, new Date((deps.now ?? Date.now)()));
      const row = (await tx.query(`SELECT id,parent_id FROM workspace_versions WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND retained`,
        [claim.sessionId, claim.workspaceId, currentId])).rows[0];
      if (!row) return unavailable('INCOMPLETE_VERSION_HISTORY');
      const sources = (await tx.query<{ id: string; kind: 'catalog' | 'report' }>(`SELECT f.id,f.role AS kind FROM snapshot_sources s JOIN stored_files f
        ON f.session_id=s.session_id AND f.workspace_id=s.workspace_id AND f.id=s.source_file_id
        WHERE s.session_id=$1 AND s.workspace_id=$2 AND s.version_id=$3 AND f.state='retained' ORDER BY f.id LIMIT 22`,
      [claim.sessionId, claim.workspaceId, currentId])).rows;
      const version: ReportHistoryVersion = { versionId: currentId, ...(row.parent_id ? { parentVersionId: row.parent_id } : {}), content: { sources } };
      return version;
    });
    chain.set(currentId, metadata);
    if (currentId === target.versionId && (metadata.parentVersionId !== target.parentVersionId || sourceSignature(metadata.content.sources) !== signature)) return unavailable('INCOMPLETE_VERSION_HISTORY');
    if (sourceSignature(metadata.content.sources) !== signature) break;
    const receipts = await deps.db.transaction(async tx => {
      await assertClaimAuthority(tx, claim, new Date((deps.now ?? Date.now)()));
      return (await tx.query('SELECT changes_ref FROM application_receipts WHERE session_id=$1 AND workspace_id=$2 AND new_version_id=$3 LIMIT 2',
        [claim.sessionId, claim.workspaceId, currentId])).rows;
    });
    if (receipts.length > 1) return unavailable('INCOMPLETE_VERSION_HISTORY');
    if (receipts[0]) {
      const ref = receipts[0].changes_ref?.bundle as CanonicalRef | undefined; if (!ref) return unavailable('INCOMPLETE_VERSION_HISTORY');
      const bundle = await deps.codec.get(claim, ref, { deadline: claim.deadlineAt, cancelled }) as unknown as ApplicationBundle;
      if (bundle.receipt.newVersionId !== currentId) return unavailable('INCOMPLETE_VERSION_HISTORY'); applications.push(bundle);
    }
    versionId = metadata.parentVersionId;
  }
  return { snapshot: id => { const version = chain.get(id); if (!version) throw new ApiError('RESOURCE_NOT_FOUND'); return version; }, applications };
}
