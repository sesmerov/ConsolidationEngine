import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { compactImportInspection, compactImportInspectionSchema, compactImportInspectionPageSchema } from '../../packages/contracts/src/compact-inspection.js';
import type { ImportInspectionDTO, LargeValueDescriptorDTO } from '@ce/contracts';
import { LocalPublicViews } from '../../apps/api/src/local/local-public-views.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { ApiError } from '../../apps/api/src/errors.js';

const uuid = '00000000-0000-4000-8000-000000000005';
function inspection(workspaceId = uuid): ImportInspectionDTO { return { id: randomUUID(), workspaceId, state: 'ready', createdAt: '2026-11-08T12:00:00Z', expiresAt: '2026-11-08T12:15:00Z', inspectionHash: 'a'.repeat(64), profiles: [], context: [], reports: [], diagnostics: [], requiresPartialCoverageAcceptance: false }; }
async function validate(schema: object, callback: (post: (value: unknown) => Promise<number>) => Promise<void>) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } }); app.post('/', { schema: { body: schema } }, async () => ({ ok: true }));
  try { await callback(async value => (await app.inject({ method: 'POST', url: '/', payload: value as any })).statusCode); } finally { await app.close(); }
}
describe('compact inspection summaries and authorized sections', () => {
  it('keeps summaries closed and represents the first inspection without inventing a version', async () => {
    const summary = compactImportInspection(inspection());
    await validate(compactImportInspectionSchema, async post => { expect(await post(summary)).toBe(200); expect(await post({ ...summary, reports: [] })).toBe(400); expect(await post({ ...summary, reportCount: 21 })).toBe(400); });
    await validate(compactImportInspectionPageSchema, async post => {
      const page = { workspaceId: uuid, inspectionId: uuid, section: 'diagnostics', revision: 1, items: [{ code: 'SYNTHETIC', message: 'Información' }], total: 1, nextCursor: null };
      expect(await post(page)).toBe(200); expect(await post({ ...page, versionId: uuid })).toBe(200); expect(await post({ ...page, items: Array(51).fill(page.items[0]) })).toBe(400);
      expect(await post({ ...page, items: [{ ...page.items[0], privateKey: 'hidden' }] })).toBe(400);
    });
  });
  it('pages immutable diagnostics, reconstructs a large value and revokes access with its inspection', async () => {
    const store = new WorkspaceStore(), workspace = store.create('SYNTHETIC'), views = new LocalPublicViews(store);
    const source = { ...inspection(workspace.id), diagnostics: Array.from({ length: 51 }, (_, i) => ({ code: 'D' + i, message: i ? 'Dato ' + i : 'Dato completo á'.repeat(20_000) })) };
    let active = true; const authorize = async () => { if (!active) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE'); };
    const first = await views.inspectionItems(workspace.id, source, { section: 'diagnostics', limit: '50' }, authorize);
    expect(first.items).toHaveLength(50); expect(first.total).toBe(51); expect(first).not.toHaveProperty('versionId'); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024);
    const descriptor = first.items[0] as LargeValueDescriptorDTO; expect(descriptor).toHaveProperty('valueRef'); const chunks: Uint8Array[] = [];
    for (let i = 0; i < Math.ceil(descriptor.byteLength / (128 * 1024)); i++) chunks.push((await views.valuePart(workspace.id, descriptor.valueRef, i)).bytes);
    const bytes = Buffer.concat(chunks); expect(createHash('sha256').update(bytes).digest('hex')).toBe(descriptor.sha256); expect(JSON.parse(bytes.toString())).toEqual(source.diagnostics[0]);
    const second = await views.inspectionItems(workspace.id, source, { section: 'diagnostics', cursor: first.nextCursor! }, authorize); expect(second.items).toEqual([source.diagnostics[50]]); expect(second.nextCursor).toBeNull();
    await expect(views.inspectionItems(workspace.id, source, { section: 'reports', cursor: first.nextCursor! }, authorize)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    active = false; await expect(views.valuePart(workspace.id, descriptor.valueRef, 0)).rejects.toMatchObject({ code: 'IMPORT_INSPECTION_NOT_APPLICABLE' }); views.close();
  });
});
