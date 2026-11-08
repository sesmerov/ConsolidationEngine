import { describe, expect, it } from 'vitest';
import { DEFAULT_DEMO_LIMITS } from '@ce/contracts';
import { readRuntimeConfig } from '../../apps/api/src/hosted/config.js';

const key = Buffer.alloc(32, 19).toString('base64url');
const hosted = () => ({ CE_MODE: 'hosted', DATABASE_URL: 'postgresql://demo:secret@db.example/demo?sslmode=require',
  PUBLIC_API_URL: 'https://api.example/', ALLOWED_ORIGINS: 'https://web.example/,https://preview.example',
  CE_CURSOR_SIGNING_KEY: key, BLOB_READ_WRITE_TOKEN: 'blob-test', QSTASH_TOKEN: 'queue-test',
  QSTASH_CURRENT_SIGNING_KEY: 'current-test', QSTASH_NEXT_SIGNING_KEY: 'next-test' });

describe('hosted configuration', () => {
  it('keeps the default local mode free from provider requirements', () => {
    expect(readRuntimeConfig({})).toEqual({ mode: 'local' });
    expect(() => readRuntimeConfig({ CE_MODE: 'unknown' })).toThrow(/CE_MODE/);
  });
  it('normalizes exact origins and preserves separate business and public admission budgets', () => {
    const config = readRuntimeConfig(hosted());
    if (config.mode === 'local') throw new Error('Expected hosted config');
    expect(config.publicApiOrigin).toBe('https://api.example');
    expect(config.allowedOrigins).toEqual(['https://web.example', 'https://preview.example']);
    expect(config.cursorSigningKey).toEqual(Buffer.alloc(32, 19));
    expect(config.limits).toEqual(DEFAULT_DEMO_LIMITS);
    expect(config.quotas.blobBytes).toBe(768 * 1024 * 1024);
    expect(config.quotas.blobMaintenanceTransferBytes).toBe(1024 ** 3);
    expect(config.quotas.cpuGlobal).toBe(1);
    expect(config.quotas.safeLeaseMs).toBe(120_000);
  });
  it.each(['https://user:pass@api.example', 'https://api.example/path', 'https://api.example/?q=x',
    'https://api.example/#x', 'http://api.example', 'http://localhost:3351', '*'])('rejects production origin %s', origin => {
    expect(() => readRuntimeConfig({ ...hosted(), PUBLIC_API_URL: origin })).toThrow(/PUBLIC_API_URL/);
  });
  it('requires exact allowlisted origins and all secrets without echoing values', () => {
    expect(() => readRuntimeConfig({ ...hosted(), ALLOWED_ORIGINS: 'https://*.example' })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => readRuntimeConfig({ ...hosted(), QSTASH_TOKEN: '' })).toThrow(/QSTASH_TOKEN/);
    expect(() => readRuntimeConfig({ ...hosted(), DATABASE_URL: 'not-a-url-super-secret' })).toThrow('Invalid DATABASE_URL');
    expect(() => readRuntimeConfig({ ...hosted(), CE_CURSOR_SIGNING_KEY: 'secret-31-bytes' })).toThrow(/CE_CURSOR_SIGNING_KEY/);
  });
  it('uses controlled providers only in hosted-test, with plaintext SQL restricted to loopback', () => {
    const config = readRuntimeConfig({ CE_MODE: 'hosted-test', DATABASE_URL: 'postgres://demo:test@127.0.0.1:5432/demo',
      PUBLIC_API_URL: 'http://localhost:3351/', ALLOWED_ORIGINS: 'http://127.0.0.1:3350', CE_CURSOR_SIGNING_KEY: key });
    expect(config.mode).toBe('hosted-test');
    if (config.mode === 'local') throw new Error('Expected hosted-test config');
    expect(config.databaseTls).toBe('loopback-test');
    expect(config.providers).toBeUndefined();
    expect(() => readRuntimeConfig({ ...hosted(), DATABASE_URL: 'postgres://a:b@db.example/db?sslmode=disable' })).toThrow(/DATABASE_URL/);
  });
  it('accepts explicit admission overrides but refuses invalid or silently changed business caps', () => {
    const config = readRuntimeConfig({ ...hosted(), CE_MAX_ACTIVE_SESSIONS: '2', CE_MAX_JOBS_PER_DAY: '12' });
    if (config.mode === 'local') throw new Error('Expected hosted config');
    expect(config.limits.maxActiveSessions).toBe(2);
    expect(config.limits.maxJobsPerDay).toBe(12);
    expect(() => readRuntimeConfig({ ...hosted(), CE_MAX_QUEUED_JOBS: '0' })).toThrow(/CE_MAX_QUEUED_JOBS/);
    expect(() => readRuntimeConfig({ ...hosted(), CE_MAX_FILE_BYTES: '1000' })).toThrow(/CE_MAX_FILE_BYTES/);
    expect(() => readRuntimeConfig({ ...hosted(), CE_BLOB_ADVANCED_OPERATIONS: '100' })).toThrow(/maintenance/);
  });
});
