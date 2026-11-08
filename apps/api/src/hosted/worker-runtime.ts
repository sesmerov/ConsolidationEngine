import type { HostedWorkerRequest } from '../workers/protocol.js';
import { BlobObjectTransport, type PrivateObjectTransport } from './blob-object-store.js';
import { CanonicalCodec, type CanonicalRef } from './canonical-codec.js';
import { readRuntimeConfig, type HostedConfig } from './config.js';
import { HostedDatabase } from './database.js';
import { ObjectLedger } from './object-ledger.js';
import { PostgresRepository } from './postgres-repository.js';
import { HostedProjectionWriter } from './projection-store.js';
import { HostedQueryRepository } from './query-repository.js';
import { QuotaLedger } from './quota-ledger.js';
import { HostedSnapshotCodec } from './snapshot-codec.js';

export interface HostedDomainOptions { readonly config: HostedConfig; readonly db: HostedDatabase; readonly transport: PrivateObjectTransport; readonly now?: () => number }
/** Stateless domain dependencies can be shared by one API instance; they contain no visitor cache or process job authority. */
export function constructHostedDomain(options: HostedDomainOptions) {
  const { db, config, transport } = options, now = options.now ?? Date.now;
  const quotas = new QuotaLedger(db, config), objects = new ObjectLedger(db, transport, quotas, () => new Date(now()));
  const codec = new CanonicalCodec(objects), indexes = new HostedProjectionWriter(db, quotas, objects, { now });
  const snapshots = new HostedSnapshotCodec(db, objects, indexes);
  const repository = new PostgresRepository(db, { now, hydrateSnapshot: (owner, ref) => snapshots.hydrateSnapshot(owner, ref as CanonicalRef) });
  const queries = new HostedQueryRepository(db, codec, { now, signingKey: config.cursorSigningKey });
  return { db, config, quotas, objects, codec, indexes, snapshots, repository, queries, now };
}
export type HostedCommandDependencies = ReturnType<typeof constructHostedDomain>;

/** Called only in an isolated worker. The worker owns exactly one SQL connection and closes it before emitting output. */
export async function createHostedWorkerRuntime(request: HostedWorkerRequest): Promise<HostedCommandDependencies & { close(): Promise<void> }> {
  const configured = request.runtime?.config ?? readRuntimeConfig();
  if (configured.mode === 'local') throw new TypeError('Hosted worker cannot execute against local state');
  const config: HostedConfig = { ...configured, cursorSigningKey: Buffer.from(configured.cursorSigningKey) };
  let transport: PrivateObjectTransport;
  if (request.runtime?.objectTransport) {
    if (config.mode !== 'hosted-test' || new URL(request.runtime.objectTransport.moduleUrl).protocol !== 'file:') throw new TypeError('Controlled transport is test-only');
    const module = await import(request.runtime.objectTransport.moduleUrl) as { ControlledFileObjectTransport: { connect(descriptor: unknown): Promise<PrivateObjectTransport> } };
    transport = await module.ControlledFileObjectTransport.connect(request.runtime.objectTransport.descriptor);
  } else {
    if (!config.providers) throw new TypeError('Hosted worker needs an explicit private transport');
    transport = new BlobObjectTransport(config.providers.blobReadWriteToken);
  }
  const db = new HostedDatabase({ databaseUrl: config.databaseUrl, tls: config.databaseTls, schema: request.schema, poolMaximum: 1 });
  try { return { ...constructHostedDomain({ db, config, transport }), close: () => db.close() }; }
  catch (error) { await db.close(); throw error; }
}
