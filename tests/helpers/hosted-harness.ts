import { randomBytes, randomUUID } from 'node:crypto';
import { HostedDatabase } from '../../apps/api/src/hosted/database.js';
import { readRuntimeConfig, type HostedConfig } from '../../apps/api/src/hosted/config.js';
import { ControlledBarriers, ControlledQueue } from './controlled-queue.js';
import { ControlledObjects, ControlledObjectTransport } from './controlled-objects.js';

export class ControlledClock {
  constructor(private current = Date.parse('2026-11-08T12:00:00.000Z')) {}
  readonly now = (): number => this.current;
  date(): Date { return new Date(this.current); }
  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new TypeError('Clock only advances by nonnegative integer milliseconds');
    this.current += milliseconds;
  }
}
export interface HostedInstanceDependencies {
  readonly instanceId: string; readonly database: HostedDatabase; readonly config: HostedConfig;
  readonly clock: ControlledClock; readonly barriers: ControlledBarriers;
  readonly queue: ControlledQueue; readonly objects: ControlledObjects;
  readonly objectTransport: ControlledObjectTransport;
}
interface Closeable { close(): Promise<unknown> }
export interface HostedHarness {
  readonly schema: string; readonly databases: readonly [HostedDatabase, HostedDatabase];
  readonly clock: ControlledClock; readonly barriers: ControlledBarriers;
  readonly queue: ControlledQueue; readonly objects: ControlledObjects; readonly config: HostedConfig;
  readonly objectTransport: ControlledObjectTransport;
  /** Inject the real API composition here. Two independent apps share only PostgreSQL and provider doubles. */
  createApis<T extends Closeable>(factory: (dependencies: HostedInstanceDependencies) => Promise<T>): Promise<readonly [T, T]>;
  close(): Promise<void>;
}
/** TEST_DATABASE_URL is supplied by scripts/test-hosted.mjs or an explicitly provisioned PostgreSQL 17. */
export async function createHostedHarness(options: { readonly databaseUrl?: string; readonly now?: number } = {}): Promise<HostedHarness> {
  const databaseUrl = options.databaseUrl ?? process.env['TEST_DATABASE_URL'];
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required. Run npm run test:hosted; SQL cannot be replaced with a mock or skipped PASS.');
  const schema = `ce_test_${randomUUID().replaceAll('-', '')}`;
  const runtime = readRuntimeConfig({ CE_MODE: 'hosted-test', DATABASE_URL: databaseUrl,
    PUBLIC_API_URL: 'http://127.0.0.1:3351', ALLOWED_ORIGINS: 'http://127.0.0.1:3350',
    CE_CURSOR_SIGNING_KEY: randomBytes(32).toString('base64url') });
  if (runtime.mode === 'local') throw new Error('Expected hosted-test configuration');
  const config: HostedConfig = runtime;
  const databaseOptions = { databaseUrl: config.databaseUrl, tls: config.databaseTls, schema };
  const databases = [new HostedDatabase(databaseOptions), new HostedDatabase(databaseOptions)] as const;
  const barriers = new ControlledBarriers(), clock = new ControlledClock(options.now);
  const queue = new ControlledQueue(barriers), objects = new ControlledObjects(barriers);
  const objectTransport = new ControlledObjectTransport(barriers);
  const apps: Closeable[] = [];
  let closed = false, apiPairCreated = false;
  async function close(): Promise<void> {
    if (closed) return; closed = true;
    barriers.releaseAll();
    const failures: unknown[] = [];
    for (const app of apps.reverse()) { try { await app.close(); } catch (error) { failures.push(error); } }
    // Only the UUID schema allocated in this invocation is eligible for removal; never public or another test's schema.
    try { if (!/^ce_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema'); await databases[0].query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    catch (error) { failures.push(error); }
    const results = await Promise.allSettled(databases.map(db => db.close()));
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    objects.clear(); objectTransport.clear();
    if (failures.length) throw new AggregateError(failures, 'Hosted test resources could not all be released');
  }
  try { await Promise.all(databases.map(db => db.migrate())); }
  catch (error) { await close().catch(() => undefined); throw error; }
  return { schema, databases, clock, barriers, queue, objects, objectTransport, config,
    async createApis<T extends Closeable>(factory: (dependencies: HostedInstanceDependencies) => Promise<T>): Promise<readonly [T, T]> {
      if (closed || apiPairCreated) throw new Error('API pair can only be created once per active harness');
      apiPairCreated = true;
      const created: T[] = [];
      try {
        for (let index = 0; index < databases.length; index++) {
          const app = await factory({ instanceId: `test-instance-${index + 1}`, database: databases[index]!, config, clock, barriers, queue, objects, objectTransport });
          apps.push(app); created.push(app);
        }
      } catch (error) { await close().catch(() => undefined); throw error; }
      return [created[0]!, created[1]!] as const;
    }, close,
  };
}
