import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { ApiError } from '../errors.js';
import { COREP_MAPPING_SHA256, COREP_PROFILE_ID } from '../import/profiles/corep-ca1.js';
import { DEMO_TYPES_MAPPING_SHA256, DEMO_TYPES_PROFILE_ID } from '../import/profiles/demo-types.js';
import { FINREP_MAPPING_SHA256,FINREP_PROFILE_ID } from '../import/profiles/finrep-f0101.js';

export type VisualReportProfile = typeof COREP_PROFILE_ID | typeof DEMO_TYPES_PROFILE_ID | typeof FINREP_PROFILE_ID;
const directory = new URL(import.meta.url.endsWith('.ts') ? '../../../../assets/templates/' : '../assets/templates/', import.meta.url);
const profiles = { [COREP_PROFILE_ID]: { file: 'corep-ca1.xlsx', mappingSha256: COREP_MAPPING_SHA256 }, [DEMO_TYPES_PROFILE_ID]: { file: 'demo-types.xlsx', mappingSha256: DEMO_TYPES_MAPPING_SHA256 },[FINREP_PROFILE_ID]:{file:'finrep-f0101.xlsx',mappingSha256:FINREP_MAPPING_SHA256} } as const;
const maximumWorkbook = 10 * 1024 * 1024, maximumExpanded = 4 * 1024 * 1024, maximumManifest = 64 * 1024;
const invalid = (): never => { throw new ApiError('INTERNAL_ERROR'); };
async function boundedRead(file: URL, maximum: number, check: () => void): Promise<Buffer> {
  check(); const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximum) invalid();
  const bytes = await readFile(file); check(); if (bytes.length !== metadata.size || bytes.length > maximum) invalid(); return bytes;
}
/** Built applications read only their packaged, versioned assets. The original upload is never a template. */
export async function visualTemplateBytes(profileId: VisualReportProfile, check: () => void = () => {}): Promise<Buffer> {
  if (!Object.hasOwn(profiles, profileId)) return invalid();
  const expected = profiles[profileId], manifest = JSON.parse((await boundedRead(new URL('manifest.json', directory), maximumManifest, check)).toString('utf8')) as { version?: unknown; profiles?: unknown };
  if (manifest.version !== 1 || !Array.isArray(manifest.profiles) || manifest.profiles.length !== 3) return invalid();
  const matches = manifest.profiles.filter((entry: unknown) => entry && typeof entry === 'object' && 'profileId' in entry && entry.profileId === profileId);
  if (matches.length !== 1) return invalid();
  const entry = matches[0] as { file?: unknown; sha256?: unknown; size?: unknown; mappingSha256?: unknown; languageProfileId?: unknown };
  if (entry.file !== expected.file || entry.mappingSha256 !== expected.mappingSha256 || entry.languageProfileId !== 'ce-dpmxl-0.9-closed-v2'
    || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > maximumWorkbook) return invalid();
  const bytes = await boundedRead(new URL(expected.file, directory), maximumWorkbook, check);
  if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return invalid(); return bytes;
}
/** A small, fixed product package is materialized within its own hard bound; no uploaded ZIP is read here. */
export async function visualTemplateParts(profileId: VisualReportProfile, check: () => void): Promise<Map<string, Buffer>> {
  const bytes = await visualTemplateBytes(profileId, check);
  const allowed = new Set(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', ...(profileId !== DEMO_TYPES_PROFILE_ID ? ['xl/styles.xml', 'xl/theme/theme1.xml'] : [])]);
  const parts = new Map<string, Buffer>(); let expanded = 0, active: Readable | undefined, zip: ZipFile | undefined;
  try {
    zip = await new Promise<ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
    await new Promise<void>((resolve, reject) => {
      zip!.on('error', reject); zip!.on('end', resolve);
      zip!.on('entry', (entry: Entry) => { void (async () => {
        check(); if (!allowed.has(entry.fileName) || parts.has(entry.fileName) || parts.size >= 32 || entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)
          || entry.uncompressedSize > maximumExpanded || expanded + entry.uncompressedSize > maximumExpanded || (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) invalid();
        active = await new Promise<Readable>((ok, fail) => zip!.openReadStream(entry, (error, stream) => error ? fail(error) : ok(stream)));
        const chunks: Buffer[] = []; let size = 0, checksum = 0;
        for await (const chunk of active) { check(); const bytes = chunk as Buffer; size += bytes.length; if (size > entry.uncompressedSize || expanded + size > maximumExpanded) invalid(); checksum = crc32(bytes, checksum); chunks.push(bytes); }
        active = undefined; if (size !== entry.uncompressedSize || checksum !== entry.crc32) invalid(); expanded += size; parts.set(entry.fileName, Buffer.concat(chunks));
      })().then(() => zip!.readEntry(), reject); }); zip!.readEntry();
    });
    if (parts.size !== allowed.size) invalid(); check(); return parts;
  } catch (error) { if (error instanceof ApiError) throw error; return invalid(); }
  finally { active?.destroy(); zip?.close(); }
}
