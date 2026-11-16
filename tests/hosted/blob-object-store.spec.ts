import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobAccessError } from '@vercel/blob';
import { BlobObjectTransport } from '../../apps/api/src/hosted/blob-object-store.js';

const privateKey = 'ce/v1/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003';
function fixture() {
  const calls = { put: vi.fn().mockResolvedValue({ url: 'https://provider.invalid/private' }), get: vi.fn(), del: vi.fn().mockResolvedValue(undefined) };
  const log = vi.fn(), transport = new BlobObjectTransport('synthetic-test-token', calls as unknown as NonNullable<ConstructorParameters<typeof BlobObjectTransport>[1]>, log);
  return { calls, transport, log };
}
const body = (chunks: Uint8Array[], size = chunks.reduce((sum, bytes) => sum + bytes.length, 0)) => ({ statusCode: 200, blob: { size }, stream: new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) });
describe('private Blob provider adapter with controlled SDK boundary', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('uses private immutable keys, explicit credentials and caller cancellation without exposing provider URLs', async () => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', undefined); const { transport, calls } = fixture(), controller = new AbortController(), bytes = Buffer.from('synthetic');
    expect(process.env['VERCEL_BLOB_RETRIES']).toBe('0'); expect(await transport.put(privateKey, bytes, controller.signal)).toBeUndefined();
    expect(calls.put).toHaveBeenCalledExactlyOnceWith(privateKey, bytes, { access: 'private', token: 'synthetic-test-token', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/octet-stream', abortSignal: controller.signal });
    calls.get.mockResolvedValueOnce(body([bytes])); expect(await transport.get(privateKey, controller.signal)).toEqual(bytes);
    expect(calls.get).toHaveBeenCalledExactlyOnceWith(privateKey, { access: 'private', token: 'synthetic-test-token', useCache: false, abortSignal: controller.signal });
    await transport.remove(privateKey, controller.signal); expect(calls.del).toHaveBeenCalledExactlyOnceWith(privateKey, { token: 'synthetic-test-token', abortSignal: controller.signal });
  });
  it('fails closed if unmetered SDK retries are enabled and rejects public or non-generated keys before I/O', async () => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', '10'); expect(() => fixture()).toThrow(/must be 0/); vi.stubEnv('VERCEL_BLOB_RETRIES', '0'); const { transport, calls } = fixture();
    for (const key of ['https://provider.invalid/file', '../private', 'ce/v1/not-a-uuid']) { await expect(transport.put(key, Buffer.from('x'))).rejects.toThrow(/key/); await expect(transport.get(key)).rejects.toThrow(/key/); await expect(transport.remove(key)).rejects.toThrow(/key/); }
    expect(calls.put).not.toHaveBeenCalled(); expect(calls.get).not.toHaveBeenCalled(); expect(calls.del).not.toHaveBeenCalled();
  });
  it('accepts the exact 3 MiB boundary and rejects oversized or incomplete responses', async () => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', '0'); const { transport, calls } = fixture(), bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    await transport.put(privateKey, bytes); await expect(transport.put(privateKey, Buffer.alloc(bytes.length + 1))).rejects.toThrow(/budget/); expect(calls.put).toHaveBeenCalledTimes(1);
    calls.get.mockResolvedValueOnce(body([bytes])); expect((await transport.get(privateKey))?.byteLength).toBe(bytes.length);
    calls.get.mockResolvedValueOnce(body([Buffer.from('x')], bytes.length + 1)); await expect(transport.get(privateKey)).rejects.toThrow(/length/);
    calls.get.mockResolvedValueOnce(body([Buffer.from('xx')], 1)); await expect(transport.get(privateKey)).rejects.toThrow(/interrupted/);
    calls.get.mockResolvedValueOnce(body([Buffer.from('x')], 2)); await expect(transport.get(privateKey)).rejects.toThrow(/Incomplete/);
    calls.get.mockResolvedValueOnce(null); expect(await transport.get(privateKey)).toBeNull();
  });
  it('does not retry a rejected provider call implicitly', async () => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', '0'); const { transport, calls } = fixture(); calls.put.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await expect(transport.put(privateKey, Buffer.from('x'))).rejects.toThrow('lost acknowledgement'); expect(calls.put).toHaveBeenCalledTimes(1);
  });
  it('diagnoses provider failures without copying private keys, credentials or exception messages', async () => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', '0'); const { transport, calls, log } = fixture();
    const denied = new BlobAccessError(), unknown = new Error('private provider response and secret token');
    calls.get.mockRejectedValueOnce(denied);
    await expect(transport.get(privateKey)).rejects.toBe(denied);
    expect(log).toHaveBeenLastCalledWith('provider_failed', { providerOperation: 'blob-get', providerReason: 'access' });
    calls.put.mockRejectedValueOnce(unknown);
    await expect(transport.put(privateKey, Buffer.from('x'))).rejects.toBe(unknown);
    expect(log).toHaveBeenLastCalledWith('provider_failed', { providerOperation: 'blob-put', providerReason: 'other' });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|private provider|synthetic-test-token|ce\/v1/);
    log.mockImplementation(() => { throw new Error('sink failure'); }); calls.del.mockRejectedValueOnce(unknown);
    await expect(transport.remove(privateKey)).rejects.toBe(unknown);
  });
  it('reads missing Content-Length with a bounded counter, but rejects empty, oversized and explicitly invalid lengths', async () => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', '0'); const { transport, calls, log } = fixture();
    const missingLength = (chunks: Uint8Array[]) => ({ ...body(chunks, 0), headers: new Headers() });
    calls.get.mockResolvedValueOnce(missingLength([Buffer.from('valid')]));
    expect(await transport.get(privateKey)).toEqual(Buffer.from('valid')); expect(log).not.toHaveBeenCalled();
    const max = Buffer.alloc(3 * 1024 * 1024, 7);
    calls.get.mockResolvedValueOnce(missingLength([max])); expect((await transport.get(privateKey))?.length).toBe(max.length);
    calls.get.mockResolvedValueOnce(missingLength([max, Buffer.from('x')])); await expect(transport.get(privateKey)).rejects.toThrow(/interrupted/);
    expect(log).toHaveBeenLastCalledWith('provider_failed', { providerOperation: 'blob-read', providerReason: 'read-limit' });
    calls.get.mockResolvedValueOnce(missingLength([])); await expect(transport.get(privateKey)).rejects.toThrow(/Incomplete/);
    calls.get.mockResolvedValueOnce({ ...body([Buffer.from('x')], 0), headers: new Headers({ 'content-length': '0' }) });
    await expect(transport.get(privateKey)).rejects.toThrow(/length/);
    expect(log).toHaveBeenLastCalledWith('provider_failed', { providerOperation: 'blob-read', providerReason: 'invalid-length' });
    calls.get.mockResolvedValueOnce(body([Buffer.from('x')], 2));
    await expect(transport.get(privateKey)).rejects.toThrow(/Incomplete/);
    expect(log).toHaveBeenLastCalledWith('provider_failed', { providerOperation: 'blob-read', providerReason: 'incomplete-read' });
  });
  it('cancels rejected responses and aborts a pending stream read without retaining its reader lock', async () => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', '0'); const { transport, calls, log } = fixture(), cancel = vi.fn();
    const invalid = new ReadableStream<Uint8Array>({ cancel });
    calls.get.mockResolvedValueOnce({ statusCode: 304, blob: { size: 0 }, headers: new Headers(), stream: invalid });
    await expect(transport.get(privateKey)).rejects.toThrow(/length/); expect(cancel).toHaveBeenCalledTimes(1); expect(invalid.locked).toBe(false);
    const controller = new AbortController(), aborted = new ReadableStream<Uint8Array>({ cancel });
    calls.get.mockResolvedValueOnce({ statusCode: 200, blob: { size: 0 }, headers: new Headers(), stream: aborted });
    const reading = transport.get(privateKey, controller.signal), rejection = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await rejection;
    expect(cancel).toHaveBeenCalledTimes(2); expect(aborted.locked).toBe(false);
    expect(log).toHaveBeenLastCalledWith('provider_failed', { providerOperation: 'blob-read', providerReason: 'timeout' });
  });
  it('deletes a bounded batch with one provider request and rejects unbounded lists before I/O', async () => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', '0'); const { transport, calls } = fixture(), controller = new AbortController();
    const keys = Array.from({ length: 100 }, (_, i) => privateKey.slice(0, -12) + String(i).padStart(12, '0'));
    await transport.removeMany(keys, controller.signal); expect(calls.del).toHaveBeenCalledExactlyOnceWith(keys, { token: 'synthetic-test-token', abortSignal: controller.signal });
    await expect(transport.removeMany([...keys, privateKey])).rejects.toThrow(/1–100/); await expect(transport.removeMany([])).rejects.toThrow(/1–100/); expect(calls.del).toHaveBeenCalledTimes(1);
  });
});
