import { DEFAULT_DEMO_LIMITS, type DemoPublicLimitsDTO } from '@ce/contracts';

export type DatabaseTls = 'verify-full' | 'loopback-test';
export interface HostedQuotas {
  readonly cpuGlobal: 1; readonly cpuPerInstance: 1; readonly cpuPerWorkspace: 1;
  readonly queueTtlMs: number; readonly jobDeadlineMs: 60_000; readonly callbackDeadlineMs: 120_000;
  readonly safeLeaseMs: 120_000; readonly maxDeliveryRetries: 3; readonly cleanupAlertMs: number;
  readonly blobBytes: number; readonly sqlBytes: number;
  readonly blobAdvancedOperations: number; readonly blobSimpleOperations: number; readonly blobTransferBytes: number;
  readonly blobMaintenanceAdvancedOperations: number; readonly blobMaintenanceSimpleOperations: number;
  readonly blobMaintenanceTransferBytes: number; readonly queuePublicDeliveriesPerDay: number; readonly queueMaintenanceDeliveriesPerDay: number;
  readonly capacityRssBytes: number; readonly capacityTmpBytes: number; readonly exportTemporaryBytes: number;
}
export interface ProviderCredentials {
  readonly blobReadWriteToken: string; readonly qstashToken: string;
  readonly qstashCurrentSigningKey: string; readonly qstashNextSigningKey: string;
}
export interface HostedConfig {
  readonly mode: 'hosted' | 'hosted-test';
  readonly databaseUrl: string; readonly databaseTls: DatabaseTls;
  readonly publicApiOrigin: string; readonly allowedOrigins: readonly string[];
  readonly cursorSigningKey: Buffer; readonly providers?: ProviderCredentials;
  readonly limits: DemoPublicLimitsDTO; readonly quotas: HostedQuotas;
}
export type RuntimeConfig = { readonly mode: 'local' } | HostedConfig;
type Environment = Readonly<Record<string, string | undefined>>;
const MiB = 1024 ** 2, GiB = 1024 ** 3;

/** Errors identify the setting, never the provided value (which may contain a secret). */
export class ConfigurationError extends Error {
  constructor(setting: string, reason = '') { super(`Invalid ${setting}${reason ? `: ${reason}` : ''}`); this.name = 'ConfigurationError'; }
}
export function isLoopbackHost(hostname: string): boolean { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase()); }
function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value || /[\r\n\0]/.test(value)) throw new ConfigurationError(name);
  return value;
}
export function normalizeOrigin(value: string, allowLoopbackHttp: boolean, setting = 'origin'): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || value.includes('?') || value.includes('#') || parsed.pathname !== '/'
      || parsed.hostname.includes('*') || !parsed.hostname
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowLoopbackHttp && isLoopbackHost(parsed.hostname)))) throw new Error();
    return parsed.origin;
  } catch { throw new ConfigurationError(setting); }
}
/** URL SSL options cannot replace our verified TLS configuration in node-postgres. */
export function normalizeDatabaseUrl(value: string, tls: DatabaseTls, setting = 'DATABASE_URL'): string {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2
      || parsed.hash || (tls === 'loopback-test' && !isLoopbackHost(parsed.hostname))) throw new Error();
    for (const [name, item] of parsed.searchParams) {
      if (name === 'sslmode') {
        if (!['require', 'verify-ca', 'verify-full'].includes(item) && !(tls === 'loopback-test' && item === 'disable')) throw new Error();
      } else if (name.toLowerCase().startsWith('ssl') || ['options', 'host', 'port', 'user', 'password', 'database', 'application_name'].includes(name)) throw new Error();
    }
    parsed.searchParams.delete('sslmode');
    return parsed.toString();
  } catch { throw new ConfigurationError(setting, tls === 'loopback-test' ? 'plaintext requires loopback' : 'verified TLS is required'); }
}
function integer(env: Environment, name: string, fallback: number): number {
  if (env[name] === undefined) return fallback;
  const value = env[name]!;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ConfigurationError(name);
  return Number(value);
}
function unchanged(env: Environment, name: string, value: number): void {
  if (env[name] !== undefined && integer(env, name, value) !== value) throw new ConfigurationError(name, 'fixed product limit');
}

export function readRuntimeConfig(env: Environment = process.env): RuntimeConfig {
  const mode = env['CE_MODE'] ?? 'local';
  if (mode === 'local') return Object.freeze({ mode });
  if (mode !== 'hosted' && mode !== 'hosted-test') throw new ConfigurationError('CE_MODE');
  // Neon's managed integration supplies a pooled DATABASE_URL and a direct URL separately.
  // A configured but invalid direct URL must fail instead of silently selecting the pooler.
  const databaseSetting = env['DATABASE_URL_UNPOOLED'] === undefined ? 'DATABASE_URL' : 'DATABASE_URL_UNPOOLED';
  const rawDatabase = required(env, databaseSetting);
  let databaseTls: DatabaseTls = 'verify-full';
  try { if (mode === 'hosted-test' && isLoopbackHost(new URL(rawDatabase).hostname)) databaseTls = 'loopback-test'; }
  catch { throw new ConfigurationError(databaseSetting); }
  const databaseUrl = normalizeDatabaseUrl(rawDatabase, databaseTls, databaseSetting);
  const publicApiOrigin = normalizeOrigin(required(env, 'PUBLIC_API_URL'), mode === 'hosted-test', 'PUBLIC_API_URL');
  const origins = required(env, 'ALLOWED_ORIGINS').split(',').map(value => normalizeOrigin(value.trim(), mode === 'hosted-test', 'ALLOWED_ORIGINS'));
  const allowedOrigins = Object.freeze([...new Set(origins)]);
  const key = required(env, 'CE_CURSOR_SIGNING_KEY');
  const cursorSigningKey = Buffer.from(key, 'base64url');
  if (cursorSigningKey.byteLength !== 32 || cursorSigningKey.toString('base64url') !== key) throw new ConfigurationError('CE_CURSOR_SIGNING_KEY', 'expected 32-byte unpadded base64url');
  const providers = mode === 'hosted' ? Object.freeze({
    blobReadWriteToken: required(env, 'BLOB_READ_WRITE_TOKEN'), qstashToken: required(env, 'QSTASH_TOKEN'),
    qstashCurrentSigningKey: required(env, 'QSTASH_CURRENT_SIGNING_KEY'), qstashNextSigningKey: required(env, 'QSTASH_NEXT_SIGNING_KEY'),
  }) : undefined;
  for (const [name, value] of Object.entries({ CE_MAX_FILE_BYTES: DEFAULT_DEMO_LIMITS.maxFileBytes, CE_MAX_BATCH_BYTES: DEFAULT_DEMO_LIMITS.maxBatchBytes,
    CE_MAX_EXPANDED_BYTES: DEFAULT_DEMO_LIMITS.maxExpandedBytes, CE_MAX_REPORTS: DEFAULT_DEMO_LIMITS.maxReports,
    CE_MAX_EXPORT_BYTES: DEFAULT_DEMO_LIMITS.maxExportBytes, CE_MAX_STATE_BYTES: DEFAULT_DEMO_LIMITS.maxStateBytes,
    CE_MAX_STORED_FILE_BYTES: DEFAULT_DEMO_LIMITS.maxStoredFileBytes, CE_MAX_SNAPSHOTS: DEFAULT_DEMO_LIMITS.maxSnapshots,
    CE_JSON_BYTES: DEFAULT_DEMO_LIMITS.jsonBytes, CE_PART_BYTES: DEFAULT_DEMO_LIMITS.partBytes, CE_PAGE_SIZE: DEFAULT_DEMO_LIMITS.pageSize })) unchanged(env, name, value);
  const limits: DemoPublicLimitsDTO = Object.freeze({ ...DEFAULT_DEMO_LIMITS,
    maxActiveSessions: integer(env, 'CE_MAX_ACTIVE_SESSIONS', 4), maxCreationsPerDay: integer(env, 'CE_MAX_CREATIONS_PER_DAY', 10),
    maxQueuedJobs: integer(env, 'CE_MAX_QUEUED_JOBS', 8), maxJobsPerDay: integer(env, 'CE_MAX_JOBS_PER_DAY', 30),
    maxJobsPer30Days: integer(env, 'CE_MAX_JOBS_PER_30_DAYS', 120),
    idleTimeoutMs: integer(env, 'CE_IDLE_TIMEOUT_MS', 60 * 60_000), absoluteTimeoutMs: integer(env, 'CE_ABSOLUTE_TIMEOUT_MS', 24 * 60 * 60_000),
    cleanupDeadlineMs: integer(env, 'CE_CLEANUP_DEADLINE_MS', 24 * 60 * 60_000),
  });
  if (limits.idleTimeoutMs > limits.absoluteTimeoutMs || limits.absoluteTimeoutMs > DEFAULT_DEMO_LIMITS.absoluteTimeoutMs
    || limits.idleTimeoutMs > DEFAULT_DEMO_LIMITS.idleTimeoutMs || limits.cleanupDeadlineMs > DEFAULT_DEMO_LIMITS.cleanupDeadlineMs) throw new ConfigurationError('CE_SESSION_TIMEOUTS', 'cannot exceed product deadlines');
  const quotas: HostedQuotas = Object.freeze({ cpuGlobal: 1, cpuPerInstance: 1, cpuPerWorkspace: 1,
    queueTtlMs: integer(env, 'CE_QUEUE_TTL_MS', 10 * 60_000), jobDeadlineMs: 60_000, callbackDeadlineMs: 120_000, safeLeaseMs: 120_000, maxDeliveryRetries: 3,
    cleanupAlertMs: integer(env, 'CE_CLEANUP_ALERT_MS', 18 * 60 * 60_000),
    blobBytes: integer(env, 'CE_BLOB_BYTES', 768 * MiB), sqlBytes: integer(env, 'CE_SQL_BYTES', 512 * MiB),
    blobAdvancedOperations: integer(env, 'CE_BLOB_ADVANCED_OPERATIONS', 1600), blobSimpleOperations: integer(env, 'CE_BLOB_SIMPLE_OPERATIONS', 8000),
    blobTransferBytes: integer(env, 'CE_BLOB_TRANSFER_BYTES', 8 * GiB),
    blobMaintenanceAdvancedOperations: integer(env, 'CE_BLOB_MAINTENANCE_ADVANCED_OPERATIONS', 200),
    blobMaintenanceSimpleOperations: integer(env, 'CE_BLOB_MAINTENANCE_SIMPLE_OPERATIONS', 1000),
    blobMaintenanceTransferBytes: integer(env, 'CE_BLOB_MAINTENANCE_TRANSFER_BYTES', GiB),
    queuePublicDeliveriesPerDay: integer(env, 'CE_QUEUE_PUBLIC_DELIVERIES_PER_DAY', 700), queueMaintenanceDeliveriesPerDay: integer(env, 'CE_QUEUE_MAINTENANCE_DELIVERIES_PER_DAY', 100),
    capacityRssBytes: Math.floor(1.6 * GiB), capacityTmpBytes: 400 * MiB, exportTemporaryBytes: 200 * MiB,
  });
  if (quotas.queueTtlMs > 10 * 60_000 || quotas.cleanupAlertMs >= limits.cleanupDeadlineMs) throw new ConfigurationError('CE_TIMING_LIMITS');
  if (quotas.blobMaintenanceAdvancedOperations < 200 || quotas.blobMaintenanceSimpleOperations < 1000 || quotas.blobMaintenanceTransferBytes < GiB
    || quotas.blobAdvancedOperations <= quotas.blobMaintenanceAdvancedOperations || quotas.blobSimpleOperations <= quotas.blobMaintenanceSimpleOperations
    || quotas.blobTransferBytes <= quotas.blobMaintenanceTransferBytes || quotas.queueMaintenanceDeliveriesPerDay < 100) throw new ConfigurationError('CE_QUOTAS', 'maintenance reserve must remain available');
  return Object.freeze({ mode, databaseUrl, databaseTls, publicApiOrigin, allowedOrigins, cursorSigningKey, ...(providers ? { providers } : {}), limits, quotas });
}
