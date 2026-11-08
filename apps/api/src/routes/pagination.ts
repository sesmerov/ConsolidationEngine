import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.js';
/** A per-app signer prevents reuse between resources, filters, collection revisions and sessions. */
export function createPager() {
  const secret = randomBytes(32), sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  return function page<T>(rows: readonly T[], key: (row: T) => string, fingerprint: string, limit = 50, cursor?: string) {
    let offset = 0;
    if (cursor) try {
      const [payload, signature, extra] = cursor.split('.'); if (!payload || !signature || extra) throw new Error();
      const actual = Buffer.from(signature), expected = Buffer.from(sign(payload)); if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { fingerprint?: string; after?: string };
      const index = rows.findIndex(row => key(row) === decoded.after); if (decoded.fingerprint !== fingerprint || index < 0) throw new Error(); offset = index + 1;
    } catch { throw new ApiError('INVALID_CURSOR'); }
    const items = rows.slice(offset, offset + limit); let nextCursor: string | null = null;
    if (offset + items.length < rows.length) { const payload = Buffer.from(JSON.stringify({ fingerprint, after: key(items.at(-1)!) })).toString('base64url'); nextCursor = payload + '.' + sign(payload); }
    return { items, total: rows.length, nextCursor };
  };
}
export const paginationProperties = { limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' }, cursor: { type: 'string', maxLength: 8192 } } as const;

/** Hosted cursors share a deployment key and seek in SQL; no process-local secret or array offset. */
export function createHostedCursorCodec(secret: Uint8Array) {
  if (secret.byteLength !== 32) throw new TypeError('Hosted cursor key must be 32 bytes');
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest();
  return {
    encode(fingerprint: string, after: { sortKey: string; rowKey: string }): string {
      const payload = Buffer.from(JSON.stringify({ fingerprint, after })).toString('base64url');
      return payload + '.' + sign(payload).toString('base64url');
    },
    decode(cursor: string, fingerprint: string): { sortKey: string; rowKey: string } {
      try {
        if (cursor.length > 8192) throw new Error();
        const [payload, signature, extra] = cursor.split('.'); if (!payload || !signature || extra) throw new Error();
        const actual = Buffer.from(signature, 'base64url'), expected = sign(payload);
        if (actual.toString('base64url') !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (value.fingerprint !== fingerprint || typeof value.after?.sortKey !== 'string' || typeof value.after?.rowKey !== 'string'
          || value.after.sortKey.length > 500 || !value.after.rowKey || value.after.rowKey.length > 500) throw new Error();
        return value.after;
      } catch { throw new ApiError('INVALID_CURSOR'); }
    },
  };
}
