import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { downloadIntentSchema, exportRequestSchema, downloadUiStates } from '../../packages/contracts/src/download.js';
import { compactPageSchema, compactValidationRunSchema, largeValueDescriptorSchema,
  publicJsonByteLength, assertPublicJsonBudget, PUBLIC_JSON_MAX_BYTES, PUBLIC_PAGE_MAX_ITEMS } from '../../packages/contracts/src/compact.js';
import { createDemoSessionSchema, demoSessionSchema, hostedBootstrapSchema, sessionSecretSchema,
  DEFAULT_DEMO_LIMITS } from '../../packages/contracts/src/demo-session.js';
import { uploadBatchCreateSchema, uploadBatchSchema, transferPartSchema, exportManifestSchema,
  uploadBatchDeclarationIssues, isCompleteTransferManifest, TRANSFER_PART_MAX_BYTES,
  INPUT_FILE_MAX_BYTES, INPUT_BATCH_MAX_BYTES, EXPORT_MAX_BYTES, EXPORT_MAX_PARTS } from '../../packages/contracts/src/transfers.js';

const id = '00000000-0000-4000-8000-000000000005';
const other = '00000000-0000-4000-8000-000000000006';
const digest = 'a'.repeat(64);
const createdAt = '2026-11-08T10:00:00.000Z';
const expiry = '2026-11-08T11:00:00.000Z';
const secret = Buffer.alloc(32, 0xab).toString('base64url');

async function validator(schema: object, check: (post: (payload: unknown) => Promise<number>) => Promise<void>): Promise<void> {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.post('/', { schema: { body: schema } }, async () => ({ valid: true }));
  try {
    await check(async value => (await app.inject({ method: 'POST', url: '/',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify(value) })).statusCode);
  } finally { await app.close(); }
}

describe('iteration 005 download identities', () => {
  it('requires an exact run identity for results and excludes it from reports', async () => {
    await validator(downloadIntentSchema, async post => {
      expect(await post({ workspaceId: id, versionId: id, kind: 'report' })).toBe(200);
      expect(await post({ workspaceId: id, versionId: id, kind: 'results', runId: other })).toBe(200);
      expect(await post({ workspaceId: id, versionId: id, kind: 'results' })).toBe(400);
      expect(await post({ workspaceId: id, versionId: id, kind: 'report', runId: other })).toBe(400);
      expect(await post({ versionId: id, kind: 'report' })).toBe(400);
      expect(await post({ workspaceId: id, versionId: 'Version 1', kind: 'report' })).toBe(400);
      expect(await post({ workspaceId: id, versionId: id, kind: 'report', url: 'https://private.example/object' })).toBe(400);
    });
  });
  it('keeps workspace ownership in the route, rather than accepting another workspace in the export body', async () => {
    await validator(exportRequestSchema, async post => {
      expect(await post({ versionId: id, kind: 'report' })).toBe(200);
      expect(await post({ versionId: id, kind: 'results', runId: other })).toBe(200);
      expect(await post({ workspaceId: other, versionId: id, kind: 'report' })).toBe(400);
      expect(await post({ versionId: id, kind: 'report', sessionId: other })).toBe(400);
    });
    expect(downloadUiStates).toEqual(['idle', 'accepting', 'preparing', 'ready', 'transferring', 'uncertain', 'failed', 'cancelled', 'expired']);
  });
});

describe('iteration 005 compact transport', () => {
  it('describes a large retained value without exposing a storage URL or silently truncating it', async () => {
    await validator(largeValueDescriptorSchema, async post => {
      const value = { valueRef: id, byteLength: PUBLIC_JSON_MAX_BYTES + 65, sha256: digest, mediaType: 'text/plain; charset=utf-8' };
      expect(await post(value)).toBe(200);
      expect(await post({ ...value, url: 'https://private.example/value' })).toBe(400);
      expect(await post({ ...value, privateObjectKey: 'other-session/key' })).toBe(400);
      expect(await post({ ...value, value: 'partial' })).toBe(400);
      expect(await post({ ...value, byteLength: -1 })).toBe(400);
      expect(await post({ ...value, sha256: 'bad' })).toBe(400);
    });
  });
  it('limits page rows independently of the actual serialized byte budget', async () => {
    const item = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } };
    await validator(compactPageSchema(item), async post => {
      const page = { workspaceId: id, versionId: id, items: Array.from({ length: 50 }, () => ({ id })), total: 51, nextCursor: 'signed-cursor' };
      expect(await post(page)).toBe(200);
      expect(await post({ ...page, items: [...page.items, { id }] })).toBe(400);
      expect(await post({ ...page, items: [], total: 0, nextCursor: null })).toBe(200);
      expect(await post({ ...page, allIds: [id] })).toBe(400);
      expect(await post({ ...page, items: [{ id, factReads: [] }] })).toBe(400);
    });
    expect(PUBLIC_PAGE_MAX_ITEMS).toBe(50);
    const exact = 'á'.repeat((PUBLIC_JSON_MAX_BYTES - 2) / 2);
    expect(publicJsonByteLength(exact)).toBe(PUBLIC_JSON_MAX_BYTES);
    expect(() => assertPublicJsonBudget(exact)).not.toThrow();
    expect(() => assertPublicJsonBudget(exact + 'x')).toThrow(RangeError);
    expect(publicJsonByteLength('"\n😀')).toBe(Buffer.byteLength(JSON.stringify('"\n😀'), 'utf8'));
  });
  it('keeps run summaries closed without all result IDs or diagnostics payloads', async () => {
    const run = { id, workspaceId: id, versionId: id, validationBasisId: other, profileId: 'ce-dpmxl-0.9-closed-v2',
      status: 'completed', startedAt: createdAt, endedAt: createdAt, diagnosticsCount: 0,
      summary: { complete: true, rows: 1, variants: 1, applicableVariants: 1, instances: 1, duplicateRows: 0,
        byStatus: { pass: 1, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 } } };
    await validator(compactValidationRunSchema, async post => {
      expect(await post(run)).toBe(200);
      expect(await post({ ...run, resultIds: [id] })).toBe(400);
      expect(await post({ ...run, diagnostics: [] })).toBe(400);
      expect(await post({ ...run, status: 'succeeded' })).toBe(400);
      expect(await post({ ...run, validationBasisId: 'some base' })).toBe(400);
    });
  });
});

describe('iteration 005 anonymous session contracts', () => {
  it('validates canonical 32-byte base64url secrets without pretending to measure entropy', async () => {
    await validator(sessionSecretSchema, async post => {
      expect(await post(secret)).toBe(200);
      expect(await post(Buffer.alloc(32).toString('base64url'))).toBe(200);
      for (const invalid of [secret + '=', secret.slice(1), secret + 'A', secret.slice(0, 42) + '_', 'https://example.test/token']) {
        expect(await post(invalid)).toBe(400);
      }
    });
  });
  it('accepts only the creation nonce in the body; token belongs in the authenticated header', async () => {
    await validator(createDemoSessionSchema, async post => {
      expect(await post({ creationNonce: secret })).toBe(200);
      expect(await post({ creationNonce: 'short' })).toBe(400);
      expect(await post({ creationNonce: secret, sessionToken: secret })).toBe(400);
      expect(await post({ creationNonce: secret, id })).toBe(400);
    });
  });
  it('returns metadata and finite public limits, never bearer/nonce/hash/provider secrets', async () => {
    const session = { id, state: 'active', createdAt, lastMeaningfulActivityAt: createdAt,
      expiresAt: expiry, absoluteExpiresAt: '2026-11-09T10:00:00.000Z', activeWorkspaceId: other };
    await validator(demoSessionSchema, async post => {
      expect(await post(session)).toBe(200);
      for (const field of ['sessionToken', 'tokenHash', 'creationNonce', 'creationNonceHash', 'databaseUrl']) {
        expect(await post({ ...session, [field]: secret })).toBe(400);
      }
      expect(await post({ ...session, expiresAt: 'tomorrow' })).toBe(400);
    });
    await validator(hostedBootstrapSchema, async post => {
      const bootstrap = { mode: 'hosted', apiVersion: 'v1', limits: DEFAULT_DEMO_LIMITS };
      expect(await post(bootstrap)).toBe(200);
      expect(await post({ ...bootstrap, sessionToken: secret })).toBe(400);
      expect(await post({ ...bootstrap, limits: { ...DEFAULT_DEMO_LIMITS, maxActiveSessions: -1 } })).toBe(400);
    });
    expect(DEFAULT_DEMO_LIMITS).toMatchObject({ idleTimeoutMs: 60 * 60_000, absoluteTimeoutMs: 24 * 60 * 60_000,
      maxStateBytes: 512 * 1024 * 1024, maxStoredFileBytes: 512 * 1024 * 1024, maxSnapshots: 20 });
  });
});

describe('iteration 005 authenticated transfer declarations', () => {
  const file = { clientFileId: 'client-file-1', role: 'catalog' as const, name: 'synthetic-catalog.xlsx', byteLength: 1024, sha256: digest };
  const report = { ...file, clientFileId: 'client-file-2', role: 'report' as const, name: 'synthetic-report.xlsx' };
  it('accepts an explicit empty base for first upload and rejects ownership/storage injection', async () => {
    await validator(uploadBatchCreateSchema, async post => {
      const batch = { baseVersionId: null, files: [file, report] };
      expect(await post(batch)).toBe(200);
      expect(await post({ ...batch, baseVersionId: id })).toBe(200);
      expect(await post({ files: batch.files })).toBe(400);
      expect(await post({ ...batch, sessionId: other })).toBe(400);
      expect(await post({ ...batch, files: [{ ...file, privateObjectKey: 'foreign' }, report] })).toBe(400);
      expect(await post({ ...batch, files: [{ ...file, byteLength: INPUT_FILE_MAX_BYTES + 1 }, report] })).toBe(400);
      expect(await post({ ...batch, files: [{ ...file, name: '../catalog.xlsx' }, report] })).toBe(400);
      expect(await post({ ...batch, files: [file] })).toBe(400);
      expect(await post({ ...batch, files: [file, ...Array.from({ length: 21 }, (_, i) => ({ ...report, clientFileId: `r${i}` }))] })).toBe(400);
    });
  });
  it('checks catalog/report cardinality, unique client identities and aggregate bytes after schema validation', () => {
    const fiveFiles = [file, ...Array.from({ length: 4 }, (_, i) => ({ ...report, clientFileId: `r${i}` }))]
      .map(value => ({ ...value, byteLength: INPUT_FILE_MAX_BYTES }));
    expect(uploadBatchDeclarationIssues({ baseVersionId: null, files: fiveFiles })).toEqual([]);
    expect(fiveFiles.reduce((n, f) => n + f.byteLength, 0)).toBe(INPUT_BATCH_MAX_BYTES);
    expect(uploadBatchDeclarationIssues({ baseVersionId: null, files: [...fiveFiles, { ...report, clientFileId: 'last' }] })).toContain('BATCH_SIZE_EXCEEDED');
    expect(uploadBatchDeclarationIssues({ baseVersionId: null, files: [file, { ...report, clientFileId: file.clientFileId }] })).toContain('DUPLICATE_CLIENT_FILE_ID');
    expect(uploadBatchDeclarationIssues({ baseVersionId: null, files: [report, { ...report, clientFileId: 'r3' }] })).toContain('CATALOG_COUNT');
    expect(uploadBatchDeclarationIssues({ baseVersionId: null, files: [file] })).toContain('REPORT_COUNT');
  });
  it('exposes only receipt metadata for a bounded binary part', async () => {
    await validator(transferPartSchema, async post => {
      const part = { index: 0, size: TRANSFER_PART_MAX_BYTES, sha256: digest };
      expect(await post(part)).toBe(200);
      expect(await post({ ...part, size: TRANSFER_PART_MAX_BYTES + 1 })).toBe(400);
      expect(await post({ ...part, size: 0 })).toBe(400);
      expect(await post({ ...part, index: -1 })).toBe(400);
      expect(await post({ ...part, body: 'base64 data' })).toBe(400);
      expect(await post({ ...part, url: 'https://private.example/part' })).toBe(400);
    });
  });
  it('returns resumable upload metadata without a path or credential', async () => {
    const upload = { ...file, id: other, partCount: 1, parts: [{ index: 0, size: file.byteLength, sha256: digest }] };
    const batch = { id, workspaceId: id, baseVersionId: null, state: 'receiving', partSize: TRANSFER_PART_MAX_BYTES,
      expiresAt: expiry, files: [upload, { ...report, id, partCount: 1, parts: [] }] };
    await validator(uploadBatchSchema, async post => {
      expect(await post(batch)).toBe(200);
      expect(await post({ ...batch, files: [{ ...upload, privateObjectKey: 'secret' }] })).toBe(400);
      expect(await post({ ...batch, partSize: TRANSFER_PART_MAX_BYTES + 1 })).toBe(400);
      expect(await post({ ...batch, token: secret })).toBe(400);
    });
  });
  it('represents a complete 100 MiB ZIP in 34 ordered parts and rejects partial or over-budget manifests', async () => {
    const parts = Array.from({ length: EXPORT_MAX_PARTS }, (_, index) => ({ index,
      size: Math.min(TRANSFER_PART_MAX_BYTES, EXPORT_MAX_BYTES - index * TRANSFER_PART_MAX_BYTES), sha256: digest }));
    const manifest = { artifactId: id, intent: { workspaceId: id, versionId: other, kind: 'report' as const },
      filename: 'synthetic-report.zip', byteLength: EXPORT_MAX_BYTES, sha256: digest, expiresAt: expiry, parts };
    expect(parts).toHaveLength(34);
    expect(isCompleteTransferManifest(manifest)).toBe(true);
    expect(isCompleteTransferManifest({ ...manifest, parts: parts.slice(0, -1) })).toBe(false);
    expect(isCompleteTransferManifest({ ...manifest, parts: [...parts].reverse() })).toBe(false);
    expect(isCompleteTransferManifest({ ...manifest, byteLength: EXPORT_MAX_BYTES + 1 })).toBe(false);
    expect(isCompleteTransferManifest({ ...manifest, parts: parts.map((part, i) => i === 33 ? { ...part, size: part.size - 1 } : part) })).toBe(false);
    await validator(exportManifestSchema, async post => {
      expect(await post(manifest)).toBe(200);
      expect(await post({ ...manifest, parts: [...parts, parts[0]] })).toBe(400);
      expect(await post({ ...manifest, byteLength: EXPORT_MAX_BYTES + 1 })).toBe(400);
      expect(await post({ ...manifest, filename: '../report.zip' })).toBe(400);
      expect(await post({ ...manifest, downloadUrl: 'https://private.example/zip' })).toBe(400);
    });
  });
});
