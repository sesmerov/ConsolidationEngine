import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { ControlledFileObjectTransport } from '../helpers/controlled-file-objects.js';

describe('owned filesystem provider for cross-worker hosted tests', () => {
  it('shares real immutable parts across a separate worker thread and verifies its owner marker', async () => {
    const transport = await ControlledFileObjectTransport.create(), key = `ce/v1/${randomUUID()}/${randomUUID()}/${randomUUID()}`, nextKey = key.slice(0, key.lastIndexOf('/') + 1) + randomUUID(), bytes = Buffer.from('synthetic shared bytes');
    try {
      await transport.put(key, bytes); const modulePath = path.join(transport.descriptor.directory, 'provider.mjs');
      await build({ entryPoints: ['tests/helpers/controlled-file-objects.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {createHash}=require('node:crypto');
        import(workerData.module).then(async ({ControlledFileObjectTransport})=>{const provider=await ControlledFileObjectTransport.connect(workerData.descriptor);const bytes=await provider.get(workerData.key);await provider.put(workerData.nextKey,bytes);parentPort.postMessage({sha256:createHash('sha256').update(bytes).digest('hex')});}).catch(()=>{parentPort.postMessage({error:true});});`, { eval: true, workerData: { module: pathToFileURL(modulePath).href, descriptor: transport.descriptor, key, nextKey } });
      const result = await new Promise<{ sha256: string }>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error('Worker exited')); }); }); await worker.terminate();
      expect(result).toEqual({ sha256: createHash('sha256').update(bytes).digest('hex') }); expect(await transport.get(nextKey)).toEqual(bytes);
      await expect(transport.put(key, Buffer.from('different'))).rejects.toThrow(/Immutable/);
      await expect(ControlledFileObjectTransport.connect({ ...transport.descriptor, transportId: randomUUID() })).rejects.toThrow(/ownership/);
      await expect(transport.get('../external')).rejects.toThrow(/key/);
    } finally { await transport.close(); }
  });
});
