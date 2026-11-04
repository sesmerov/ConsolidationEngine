import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { importContextInputSchema, safeDisplayName } from '@ce/contracts';
import type { ImportContextInputDTO, SourceFile } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { SessionFiles } from '../storage/session-files.js';
export interface StagedFile extends SourceFile { readonly path: string }
export const UPLOAD_LIMITS = { maxFileBytes: 10 * 1024 * 1024, maxBatchBytes: 50 * 1024 * 1024, maxReports: 20, receiveTimeoutMs: 120_000 } as const;
export type UploadLimits = { [K in keyof typeof UPLOAD_LIMITS]: number };
export interface StagedUpload { readonly files: readonly StagedFile[]; readonly bodyHash: string; readonly context?: ImportContextInputDTO; retain(): Promise<void>; cleanup(): Promise<void> }
export async function stageMultipart(request: FastifyRequest, storage: SessionFiles, workspaceId: string, overrides: Partial<UploadLimits> = {}, signal?: AbortSignal, mode: 'legacy' | 'inspection' = 'legacy'): Promise<StagedUpload> {
  const limits = { ...UPLOAD_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as (keyof UploadLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > UPLOAD_LIMITS[key]) throw new ApiError('INTERNAL_ERROR');
  if (!request.isMultipart()) throw new ApiError('INVALID_REQUEST');
  const lease = storage.reserve(workspaceId, limits.maxBatchBytes);
  const files: StagedFile[] = []; const allocated: string[] = [];
  let total = 0; let catalogs = 0; let reports = 0; let aborted = false; let active: Readable | undefined; let work: Promise<void> | undefined;
  let cleaned = false, retained = false; let context: ImportContextInputDTO | undefined;
  const cleanup = async () => { if (!cleaned) { await storage.removeFiles(workspaceId, allocated); lease.release(); cleaned = true; } };
  const retain = async () => { if (!retained) { await storage.retain(lease, allocated); retained = true; } };
  async function consume(part: MultipartFile): Promise<void> {
    const kind = part.fieldname === 'catalog' ? 'catalog' : part.fieldname === 'reports' ? 'report' : undefined;
    if (!kind) throw new ApiError('INVALID_REQUEST');
    if (kind === 'catalog' && ++catalogs > 1) throw new ApiError('INVALID_REQUEST');
    if (kind === 'report' && ++reports > limits.maxReports) throw new ApiError('UPLOAD_LIMIT');
    if (!/\.xlsx$/i.test(part.filename)) throw new ApiError('UNSUPPORTED_FILE_TYPE');
    const stored = await storage.openFile(workspaceId, lease); allocated.push(stored.id);
    const hash = createHash('sha256'); let size = 0; let signature = Buffer.alloc(0);
    try {
      for await (const chunk of part.file) {
        if (aborted) throw new ApiError('UPLOAD_LIMIT');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.byteLength; total += bytes.byteLength;
        if (size > limits.maxFileBytes || total > limits.maxBatchBytes) throw new ApiError('UPLOAD_LIMIT');
        if (signature.length < 4) signature = Buffer.concat([signature, bytes.subarray(0, 4 - signature.length)]);
        if (signature.length === 4 && !signature.equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw new ApiError('UNSUPPORTED_FILE_TYPE');
        hash.update(bytes); await stored.handle.writeFile(bytes);
      }
      if (part.file.truncated) throw new ApiError('UPLOAD_LIMIT');
      if (size < 4) throw new ApiError('UNSUPPORTED_FILE_TYPE');
      files.push({ id: stored.id, path: stored.path, sha256: hash.digest('hex'), displayName: safeDisplayName(part.filename), kind, size, importedAt: new Date().toISOString() });
    } finally { await stored.handle.close(); }
  }
  const processing = (async () => {
    for await (const part of request.parts({ limits: { fileSize: limits.maxFileBytes, files: limits.maxReports + 1, fields: 1, fieldSize: 16 * 1024, parts: limits.maxReports + 2 } })) {
      if (aborted) throw new ApiError('UPLOAD_LIMIT');
      if (part.type !== 'file') {
        if (mode !== 'inspection' || context !== undefined || part.fieldname !== 'context' || part.valueTruncated) throw new ApiError('INVALID_REQUEST');
        // Multipart parses application/json fields itself; ordinary form fields remain text.
        let parsed: unknown;
        try {
          const encoded = typeof part.value === 'string' ? part.value : JSON.stringify(part.value);
          if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 16 * 1024) throw new Error('Invalid context field');
          parsed = typeof part.value === 'string' ? JSON.parse(part.value) : part.value;
        } catch { throw new ApiError('INVALID_REQUEST'); }
        if (!request.compileValidationSchema(importContextInputSchema)(parsed)) throw new ApiError('INVALID_REQUEST');
        context = parsed as ImportContextInputDTO; continue;
      }
      active = part.file; work = consume(part); await work; active = undefined; work = undefined;
    }
    if (catalogs !== 1 || reports < 1 || mode === 'inspection' && context === undefined) throw new ApiError('INVALID_REQUEST');
  })();
  // Consume rejection even if the deadline wins while the iterator waits for a new part.
  void processing.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { aborted = true; active?.destroy(new ApiError('UPLOAD_LIMIT')); reject(new ApiError('UPLOAD_LIMIT')); }, limits.receiveTimeoutMs); });
  let rejectAborted!: (error: ApiError) => void;
  const externalAbort = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const abortedRequest = () => { aborted = true; const error = new ApiError('UPLOAD_LIMIT'); active?.destroy(error); rejectAborted(error); };
  const cancelled = () => { aborted = true; const error = new ApiError('RESOURCE_NOT_FOUND'); active?.destroy(error); rejectAborted(error); };
  request.raw.once('aborted', abortedRequest);
  signal?.addEventListener('abort', cancelled, { once: true }); if (signal?.aborted) cancelled();
  try {
    await Promise.race([processing, timeout, externalAbort]);
    const descriptors = files.map((file) => ({ field: file.kind === 'catalog' ? 'catalog' : 'reports', metadata: { kind: file.kind, displayName: file.displayName }, sha256: file.sha256, size: file.size }));
    if (mode === 'legacy') descriptors.sort((a, b) => canonicalHash(a).localeCompare(canonicalHash(b)));
    lease.resize(total);
    return { files, bodyHash: canonicalHash({ files: descriptors, metadata: context ?? {} }), ...(context ? { context } : {}), retain, cleanup };
  } catch (error) {
    aborted = true; active?.destroy(); await work?.catch(() => undefined); await cleanup();
    if (error instanceof ApiError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (mode === 'inspection' && /FIELDS_LIMIT|PARTS_LIMIT/.test(code)) throw new ApiError('INVALID_REQUEST');
    if (/LIMIT|FILE_TOO_LARGE/.test(code)) throw new ApiError('UPLOAD_LIMIT');
    throw new ApiError('INVALID_REQUEST');
  } finally { if (timer) clearTimeout(timer); request.raw.off('aborted', abortedRequest); signal?.removeEventListener('abort', cancelled); }
}
