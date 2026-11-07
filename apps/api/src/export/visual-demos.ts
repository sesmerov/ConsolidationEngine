import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { ApiError } from '../errors.js';

export type VisualDemo = 'corep' | 'types' | 'finrep';
export type VisualDemoArtifact = 'catalog' | 'report';
const maxWorkbookBytes = 10 * 1024 * 1024, maxManifestBytes = 16 * 1024;
// Source tests use versioned assets. Built applications use only their packaged assets.
const directory = new URL(import.meta.url.endsWith('.ts') ? '../../../../assets/demos/' : '../assets/demos/', import.meta.url);
async function boundedFile(url: URL, maximum: number): Promise<Buffer> {
  const info = await lstat(url);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) throw new ApiError('INTERNAL_ERROR');
  const bytes = await readFile(url); if (bytes.length !== info.size || bytes.length > maximum) throw new ApiError('INTERNAL_ERROR'); return bytes;
}
/** Fixed product assets, with no runtime dependency on planning documents or original source files. */
export async function visualDemo(demo: VisualDemo, kind: VisualDemoArtifact): Promise<Buffer> {
  const file = `demo-${demo}-${kind}.xlsx`;
  if (!['corep', 'types','finrep'].includes(demo) || !['catalog', 'report'].includes(kind)) throw new ApiError('RESOURCE_NOT_FOUND');
  const manifest = JSON.parse((await boundedFile(new URL('manifest.json', directory), maxManifestBytes)).toString('utf8')) as { version?: unknown; files?: unknown };
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== 6) throw new ApiError('INTERNAL_ERROR');
  const matches = manifest.files.filter((entry: unknown) => entry && typeof entry === 'object' && 'demo' in entry && entry.demo === demo && 'kind' in entry && entry.kind === kind);
  if (matches.length !== 1) throw new ApiError('INTERNAL_ERROR');
  const entry = matches[0] as { file?: unknown; sha256?: unknown; size?: unknown };
  if (entry.file !== file || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 4 || entry.size > maxWorkbookBytes) throw new ApiError('INTERNAL_ERROR');
  const bytes = await boundedFile(new URL(file, directory), maxWorkbookBytes);
  if (bytes.length !== entry.size || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new ApiError('INTERNAL_ERROR');
  return bytes;
}
