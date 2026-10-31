import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
/** Canonical JSON in bounded string fragments; never stringify a whole result bundle. */
export function* jsonChunks(value: JsonValue): Generator<string> {
  function* quoted(text: string): Generator<string> {
    yield '"';
    for (let start = 0; start < text.length;) { let end = Math.min(start + 4096, text.length); const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++;
      yield JSON.stringify(text.slice(start, end)).slice(1, -1); start = end; }
    yield '"';
  }
  if (typeof value === 'string') { yield* quoted(value); return; }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') { if (typeof value === 'number' && !Number.isFinite(value)) throw new ApiError('INTERNAL_ERROR'); yield String(value); return; }
  if (Array.isArray(value)) { yield '['; for (const [index, item] of value.entries()) { if (index) yield ','; yield* jsonChunks(item); } yield ']'; return; }
  if (!value || typeof value !== 'object') throw new ApiError('INTERNAL_ERROR');
  yield '{'; for (const [index, key] of Object.keys(value).sort().entries()) { if (index) yield ','; yield* quoted(key); yield ':'; yield* jsonChunks((value as { readonly [key: string]: JsonValue })[key]!); } yield '}';
}
export function jsonBytes(value: JsonValue, maximum: number, check: () => void = () => {}): number {
  let size = 0; for (const chunk of jsonChunks(value)) { check(); size += Buffer.byteLength(chunk, 'utf8'); if (size > maximum) throw new ApiError('EXPORT_LIMIT'); } return size;
}
