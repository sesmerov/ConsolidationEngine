import type { JsonObject, JsonValue, Snapshot, SnapshotContent, SnapshotPublicationReason } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { versionExportSummary } from '../export/report-ownership.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import { catalogRows } from '../presentation/catalog-rows.js';
import { canonicalHash, canonicalStringify } from '../session/canonical-state.js';
import { CanonicalCodec, type CanonicalRef, type CanonicalWriteContext } from './canonical-codec.js';
import type { HostedDatabase } from './database.js';
import type { HostedJobClaim } from './job-coordinator.js';
import type { ObjectLedger } from './object-ledger.js';
import { HostedProjectionWriter, type ProjectionIndexRef } from './projection-store.js';
import type { PublishedBasis, PublishedIndex, PublishedVersion } from './publication.js';

interface Components { readonly catalog: CanonicalRef; readonly data: CanonicalRef; readonly contexts: CanonicalRef; readonly configuration: CanonicalRef }
interface SnapshotManifest {
  readonly schemaVersion: 1; readonly metadata: Omit<Snapshot, 'content'>;
  readonly contentMetadata: Pick<SnapshotContent, 'catalogVersion' | 'reportVersion' | 'configVersion' | 'profileId'>;
  readonly roots: Components;
}
export class HostedSnapshotCodec {
  readonly codec: CanonicalCodec;
  constructor(readonly database: HostedDatabase, readonly objects: ObjectLedger, readonly indexes: HostedProjectionWriter) { this.codec = new CanonicalCodec(objects); }
  async hydrateSnapshot(owner: WorkspaceOwner, reference: CanonicalRef): Promise<Snapshot> {
    const manifest = await this.codec.get(owner, reference) as unknown as SnapshotManifest;
    if (!manifest || manifest.schemaVersion !== 1 || !manifest.metadata || !manifest.contentMetadata || !manifest.roots) throw new ApiError('INTERNAL_ERROR');
    // Sequential reads keep a single worker connection and a bounded provider request fanout.
    const catalog = await this.codec.get(owner, manifest.roots.catalog) as unknown as SnapshotContent['catalog'];
    const data = await this.codec.get(owner, manifest.roots.data) as unknown as Pick<SnapshotContent, 'coordinates' | 'facts' | 'sources' | 'reportSourceBindings'>;
    const contexts = await this.codec.get(owner, manifest.roots.contexts) as unknown as SnapshotContent['contexts'];
    const configuration = await this.codec.get(owner, manifest.roots.configuration) as unknown as Pick<SnapshotContent, 'directions' | 'directionDecisionState'>;
    const snapshot: Snapshot = { ...manifest.metadata, content: { ...manifest.contentMetadata, catalog, ...data, contexts, ...configuration } };
    if (canonicalHash(snapshot.content) !== snapshot.contentHash) throw new ApiError('INTERNAL_ERROR'); return snapshot;
  }
  async writeSnapshot(claim: HostedJobClaim, snapshot: Snapshot, reason: SnapshotPublicationReason): Promise<{
    version: PublishedVersion; basis?: PublishedBasis; canonicalRoots: readonly CanonicalRef[]; indexes: readonly PublishedIndex[]; componentRefs: Components;
  }> {
    if (!snapshot.validationBasisId || canonicalHash(snapshot.content) !== snapshot.contentHash || snapshot.parentVersionId !== claim.baseVersionId) throw new ApiError('INTERNAL_ERROR');
    const context: CanonicalWriteContext = { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt };
    const content = snapshot.content;
    const roots: Components = {
      catalog: await this.codec.put(claim, content.catalog, context),
      data: await this.codec.put(claim, { coordinates: content.coordinates, facts: content.facts, sources: content.sources,
        ...(content.reportSourceBindings ? { reportSourceBindings: content.reportSourceBindings } : {}) }, context),
      contexts: await this.codec.put(claim, content.contexts, context),
      configuration: await this.codec.put(claim, { directions: content.directions, ...(content.directionDecisionState ? { directionDecisionState: content.directionDecisionState } : {}) }, context),
    };
    const views: Record<string, ProjectionIndexRef> = {}, indexRefs: CanonicalRef[] = [], indexes: PublishedIndex[] = [];
    const recordIndex = (view: string, staged: Awaited<ReturnType<HostedProjectionWriter['stage']>>) => {
      views[view] = staged.ref; indexRefs.push(staged.manifestRef); indexes.push({ kind: staged.ref.kind, id: staged.ref.indexId, revision: staged.ref.revision, basisId: snapshot.validationBasisId! });
    };
    const basisExists = (await this.database.query('SELECT id FROM validation_bases WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [claim.sessionId, claim.workspaceId, snapshot.validationBasisId])).rowCount === 1;
    const shared = { ...(basisExists ? { basisId: snapshot.validationBasisId } : {}), revision: 1 };
    recordIndex('contexts', await this.indexes.stage(claim, { ...shared, resource: { type: 'version', id: snapshot.versionId, view: 'contexts' }, kind: 'details',
      rows: content.contexts.map(item => ({ key: item.contextId, sortKey: item.contextId, value: item as unknown as JsonValue })) }));
    recordIndex('sources', await this.indexes.stage(claim, { ...shared, resource: { type: 'version', id: snapshot.versionId, view: 'sources' }, kind: 'details',
      rows: content.sources.map(item => ({ key: item.id, sortKey: item.id, value: item as unknown as JsonValue })) }));
    recordIndex('catalog', await this.indexes.stage(claim, { ...shared, resource: { type: 'version', id: snapshot.versionId, view: 'catalog' }, kind: 'catalog',
      rows: catalogRows(snapshot).map(item => ({ key: item.id, sortKey: JSON.stringify([item.code, item.variantId ?? '', item.id]), code: item.code,
        selectors: { tables: item.tables ?? [], statuses: [item.syntaxStatus, item.supportStatus, item.applicability,
          ...(item.diagnostics.some(diagnostic => diagnostic.severity === 'error') ? ['invalid'] : [])].filter(value => value !== undefined) as string[] }, value: item as unknown as JsonValue })) }));
    // Imported versions have authoritative report bindings. Empty synthetic engine fixtures have no downloadable report.
    const exportSummary = content.sources.some(source => source.kind === 'report') ? versionExportSummary(snapshot, () => {}) : undefined;
    const compactExportSummary = exportSummary && Buffer.byteLength(canonicalStringify(exportSummary), 'utf8') <= 32_768 ? exportSummary : undefined;
    if (exportSummary) recordIndex('exportSummary', await this.indexes.stage(claim, { ...shared,
      resource: { type: 'version', id: snapshot.versionId, view: 'exportSummary' }, kind: 'details',
      rows: [{ key: 'summary', sortKey: 'summary', value: exportSummary as unknown as JsonValue }] }));
    const { content: _content, ...metadata } = snapshot;
    const manifest: SnapshotManifest = { schemaVersion: 1, metadata, contentMetadata: { profileId: content.profileId, catalogVersion: content.catalogVersion, reportVersion: content.reportVersion, configVersion: content.configVersion }, roots };
    const root = await this.objects.putCanonical(claim, Buffer.from(canonicalStringify({ codecVersion: 1, type: 'json', value: manifest })), [...Object.values(roots), ...indexRefs], context);
    const summary: JsonObject = { contextCount: content.contexts.length, directionCount: content.directions.length,
      counts: { coordinates: content.coordinates.length, facts: content.facts.length, sources: content.sources.length }, views: views as unknown as JsonObject,
      ...(compactExportSummary ? { exportSummary: compactExportSummary as unknown as JsonObject } : {}),
      coverage: content.catalog.coverage as unknown as JsonObject };
    const version: PublishedVersion = { id: snapshot.versionId, basisId: snapshot.validationBasisId, ...(snapshot.parentVersionId ? { parentId: snapshot.parentVersionId } : {}), reason,
      contentRef: root, directionsRef: roots.configuration as unknown as JsonObject, contentHash: snapshot.contentHash, configVersion: content.configVersion,
      profileId: content.profileId, catalogVersion: content.catalogVersion, reportVersion: content.reportVersion, summary, sourceFileIds: content.sources.map(source => source.id) };
    return { version, ...(reason === 'configuration' ? {} : { basis: { id: snapshot.validationBasisId,
      catalogRef: roots.catalog as unknown as JsonObject, dataRef: roots.data as unknown as JsonObject, contextsRef: roots.contexts as unknown as JsonObject,
      profileIds: [content.profileId], hashes: { catalog: roots.catalog.sha256, data: roots.data.sha256, contexts: roots.contexts.sha256 } } }),
      canonicalRoots: [root, ...indexRefs], indexes, componentRefs: roots };
  }
}
