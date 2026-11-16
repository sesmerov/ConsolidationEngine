import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { normalizeDatabaseUrl, type DatabaseTls } from './config.js';

export interface DatabaseOptions {
  readonly databaseUrl: string; readonly schema: string; readonly tls: DatabaseTls;
  /** Production uses one API connection plus one worker connection (two total per instance). */
  readonly poolMaximum?: 1 | 2;
}
export interface DatabaseTransaction {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}
export function validatedSchemaName(schema: string): string {
  if (!/^ce_[a-z][a-z0-9_]{0,55}$/.test(schema)) throw new TypeError('Invalid isolated application schema name');
  return schema;
}

export function assertSupportedPostgresVersion(version: string): void {
  if (!/^\d{6}$/.test(version) || ![17, 18].includes(Math.floor(Number(version) / 10_000))) {
    throw new Error('PostgreSQL 17 or 18 is required for the authority schema');
  }
}

/** Small authority transactions only. Release the client before network I/O or worker execution. */
export class HostedDatabase implements DatabaseTransaction {
  readonly schema: string;
  readonly poolMaximum: 1 | 2;
  private readonly pool: Pool;
  constructor(options: DatabaseOptions) {
    this.schema = validatedSchemaName(options.schema);
    this.poolMaximum = options.poolMaximum ?? 2;
    if (this.poolMaximum !== 1 && this.poolMaximum !== 2) throw new TypeError('Database pool must contain one or two connections');
    const connectionString = normalizeDatabaseUrl(options.databaseUrl, options.tls);
    const hostname = new URL(connectionString).hostname;
    this.pool = new Pool({ connectionString, max: this.poolMaximum, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 20_000,
      ssl: options.tls === 'verify-full' ? { rejectUnauthorized: true, servername: hostname } : false,
      options: `-c search_path=${this.schema},pg_catalog -c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000`,
      application_name: 'consolidation-engine',
    });
    // An idle socket failure must not terminate the process. pg evicts that client; the next query reconnects.
    // Do not log pg errors here: they may include connection details or private SQL parameter values.
    this.pool.on('error', () => undefined);
  }
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values ? [...values] : undefined);
  }
  async transaction<T>(work: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await work(this.scopedClient(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  private scopedClient(client: PoolClient): DatabaseTransaction {
    return { query: <Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) => client.query<Row>(text, values ? [...values] : undefined) };
  }
  /** Advisory lock serializes concurrent initializers; DDL, version and checksum commit together. */
  async migrate(): Promise<void> {
    const directory = new URL('./migrations/', import.meta.url);
    const filenames = (await readdir(directory)).filter(name => /^\d{3}-[a-z0-9-]+\.sql$/.test(name)).sort();
    const migrations = await Promise.all(filenames.map(async filename => {
      const sql = await readFile(new URL(filename, directory), 'utf8');
      return { version: Number(filename.slice(0, 3)), sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }));
    if (!migrations.length || migrations.some((migration, index) => migration.version !== index + 1)) throw new Error('Migrations must be consecutively numbered from 001');
    await this.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ce-migrate:${this.schema}`]);
      const version = (await tx.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]!.server_version_num;
      assertSupportedPostgresVersion(version);
      await tx.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY CHECK(version>0), checksum text NOT NULL CHECK(length(checksum)=64), applied_at timestamptz NOT NULL DEFAULT now())`);
      const previous = await tx.query<{ version: number; checksum: string }>('SELECT version,checksum FROM schema_migrations ORDER BY version');
      if (previous.rows.some(migration => !migrations.some(source => source.version === migration.version))) throw new Error('Database has migrations not present in this deployment');
      for (const migration of migrations) {
        const applied = previous.rows.find(item => item.version === migration.version);
        if (applied) {
          if (applied.checksum !== migration.checksum) throw new Error(`Migration ${migration.version} checksum mismatch; use a new versioned migration`);
          continue;
        }
        await tx.query(migration.sql);
        await tx.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [migration.version, migration.checksum]);
      }
    });
  }
  async close(): Promise<void> { await this.pool.end(); }
}
