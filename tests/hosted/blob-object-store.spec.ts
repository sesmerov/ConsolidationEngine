import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobObjectTransport } from '../../apps/api/src/hosted/blob-object-store.js';

const privateKey = 'ce/v1/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003';
function fixture() {
  const calls = { put: vi.fn().mockResolvedValue({ url: 'https://provider.invalid/private' }), get: vi.fn(), del: vi.fn().mockResolvedValue(undefined) };
  const transport = new BlobObjectTransport('synthetic-test-token', calls as unknown as NonNullable<ConstructorParameters<typeof BlobObjectTransport>[1]>);
  return { calls, transport };
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
});
