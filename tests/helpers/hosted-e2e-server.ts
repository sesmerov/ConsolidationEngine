import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HostedDatabase } from '../../apps/api/src/hosted/database.js';
import { readRuntimeConfig } from '../../apps/api/src/hosted/config.js';
import type { HostedAppOptions } from '../../apps/api/src/hosted-entry.js';
import type { AcceptedJobReference } from '../../apps/api/src/ports/job-dispatcher.js';
import { ControlledFileObjectTransport, type ControlledFileObjectDescriptor } from './controlled-file-objects.js';

const ports = { frontend: 3350, publicApi: 3351, api1: 3352, api2: 3353, control: 3354 } as const;
const origin = (port: number) => `http://127.0.0.1:${port}`;
interface ChildStartup { root: string; databaseUrl: string; schema: string; signingKey: string; internalKey: string; instance: 'api1'|'api2'; transport: ControlledFileObjectDescriptor; providerModule: string }
interface DispatchMessage { type: 'dispatch'; id: string; reference: AcceptedJobReference }
const sign = (key: string, body: string) => createHmac('sha256', key).update(origin(ports.publicApi) + '/internal/jobs\n' + body).digest('base64url');

/** Each child has its own API instance, pool, runner and process memory; only SQL/private files are shared. */
export async function startHostedE2eChild(): Promise<void> {
  let app: FastifyInstance|undefined, stopping = false;
  const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const stop = async () => { if (stopping) return; stopping = true; try { await app?.close(); } finally { for (const request of pending.values()) request.reject(new Error('Controlled queue closed')); pending.clear(); process.disconnect?.(); } };
  process.on('disconnect', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  process.on('message', (message: any) => {
    if (message?.type === 'dispatch-ack') { const request = pending.get(message.id); pending.delete(message.id); if (message.accepted) request?.resolve(); else request?.reject(new Error('Controlled queue acknowledgement lost')); }
    if (message?.type === 'stop') void stop();
  });
  const settings = await new Promise<ChildStartup>((resolve, reject) => { process.once('message', message => (message as any)?.type === 'start' ? resolve((message as any).settings) : reject(new Error('Missing test startup message'))); });
  try {
    const config = readRuntimeConfig({ CE_MODE: 'hosted-test', DATABASE_URL: settings.databaseUrl, PUBLIC_API_URL: origin(ports.publicApi), ALLOWED_ORIGINS: origin(ports.frontend), CE_CURSOR_SIGNING_KEY: settings.signingKey });
    if (config.mode !== 'hosted-test') throw new Error('Test-only runtime required');
    const transport = await ControlledFileObjectTransport.connect(settings.transport);
    const runtime = await import(pathToFileURL(path.join(settings.root, 'apps/api/dist/hosted-entry.js')).href) as { createHostedApp(options: HostedAppOptions): Promise<FastifyInstance> };
    app = await runtime.createHostedApp({ config, schema: settings.schema, instanceId: settings.instance, objectTransport: transport,
      dispatcher: { dispatch(reference) { return new Promise<void>((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); process.send?.({ type: 'dispatch', id, reference } satisfies DispatchMessage); }); } },
      signatureVerifier: { async verify(input) { const expected = Buffer.from(sign(settings.internalKey, input.body)), supplied = Buffer.from(input.signature); return input.url === origin(ports.publicApi) + '/internal/jobs' && supplied.length === expected.length && timingSafeEqual(supplied, expected); } },
      workerOptions: { workerEntry: pathToFileURL(path.join(settings.root, 'apps/api/dist/workers/hosted-operation-worker.js')), commandModule: pathToFileURL(path.join(settings.root, 'apps/api/dist/hosted/domain-commands.js')),
        runtime: { config, objectTransport: { moduleUrl: settings.providerModule, descriptor: { ...settings.transport } } } },
    });
    await app.listen({ host: '127.0.0.1', port: ports[settings.instance] }); process.send?.({ type: 'ready', instance: settings.instance });
  } catch { process.send?.({ type: 'startup-failure' }); await stop(); process.exitCode = 1; }
}

/** No provider account: this test harness replaces only queue/signature/Blob transport, not SQL or worker execution. */
export async function startHostedE2eServer(options: { root: string; temporary: string; databaseUrl: string; controlToken: string; webRoot?: string }) {
  // Fail on occupied ports. Never reuse or terminate another process's listener.
  const probes = [] as ReturnType<typeof createServer>[];
  try { for (const port of Object.values(ports)) { const probe = createServer(); probes.push(probe); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); }); } }
  finally { await Promise.all(probes.filter(server => server.listening).map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
  const schema = 'ce_e2e_' + randomUUID().replaceAll('-', ''), signingKey = randomBytes(32).toString('base64url'), internalKey = randomBytes(32).toString('base64url');
  // Load the emitted module in place so its SQL migrations keep their production relative paths.
  const databaseModule = await import(pathToFileURL(path.join(options.root, 'apps/api/dist/hosted/database.js')).href) as { HostedDatabase: typeof HostedDatabase };
  const db = new databaseModule.HostedDatabase({ databaseUrl: options.databaseUrl, tls: 'loopback-test', schema, poolMaximum: 1 }), children: ChildProcess[] = [], apps: FastifyInstance[] = [];
  let transport: ControlledFileObjectTransport|undefined, closed = false, balancing: 'auto'|'api1'|'api2' = 'auto', sequence = 0, queuePaused = false, loseNextQueueAck = false;
  let dropResponse: { method: string; pathEndsWith: string }|null = null, pumping: Promise<void>|undefined;
  const deliveries: { jobId: string; instance: string; status: number }[] = [], requests: { instance: string; method: string; path: string; status: number; operationKey?: string }[] = [], queue: AcceptedJobReference[] = [];
  const nextInstance = (): 'api1'|'api2' => balancing === 'auto' ? (++sequence % 2 ? 'api1' : 'api2') : balancing;
  const pump = () => {
    if (pumping || queuePaused || closed) return;
    pumping = (async () => { while (queue.length && !queuePaused && !closed) {
      const reference = queue[0]!, body = JSON.stringify(reference), instance = nextInstance();
      try {
        const response = await fetch(origin(ports[instance]) + '/internal/jobs', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Upstash-Signature': sign(internalKey, body) }, signal: AbortSignal.timeout(125_000) });
        await response.arrayBuffer(); deliveries.push({ jobId: reference.jobId, instance, status: response.status });
        if (response.status === 503) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
        if (!response.ok) throw new Error('Controlled callback rejected'); queue.shift();
      } catch { if (closed) break; deliveries.push({ jobId: reference.jobId, instance, status: 0 }); queue.shift(); }
    } })().finally(() => { pumping = undefined; if (queue.length && !queuePaused && !closed) pump(); });
  };
  const close = async () => {
    if (closed) return; closed = true; queue.length = 0;
    for (const app of apps.reverse()) await app.close();
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGTERM'); }, 10_000); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(); }); if (child.connected) child.send({ type: 'stop' }); else child.kill('SIGTERM'); });
    }));
    await pumping;
    if (!/^ce_e2e_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await db.close(); await transport?.close();
  };
  try {
    await db.migrate(); transport = await ControlledFileObjectTransport.create(options.temporary);
    const childEntry = path.join(options.temporary, 'api-child.mjs'); await writeFile(childEntry, 'import {startHostedE2eChild} from "./server.mjs"; await startHostedE2eChild();\n', { flag: 'wx' });
    for (const instance of ['api1','api2'] as const) {
      const child = fork(childEntry, [], { cwd: options.root, windowsHide: true, stdio: ['ignore','inherit','inherit','ipc'], serialization: 'advanced' }); children.push(child);
      child.on('message', (message: any) => { if (message?.type !== 'dispatch') return; const dispatch = message as DispatchMessage;
        queue.push(structuredClone(dispatch.reference)); const accepted = !loseNextQueueAck; loseNextQueueAck = false; child.send({ type: 'dispatch-ack', id: dispatch.id, accepted }); pump();
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Owned ${instance} startup timed out`)), 30_000);
        child.once('error', reject); child.once('exit', () => reject(new Error(`Owned ${instance} exited before ready`)));
        child.on('message', (message: any) => { if (message?.type === 'ready') { clearTimeout(timer); resolve(); } if (message?.type === 'startup-failure') { clearTimeout(timer); reject(new Error(`Owned ${instance} startup failed`)); } });
        child.send({ type: 'start', settings: { root: options.root, databaseUrl: options.databaseUrl, schema, signingKey, internalKey, instance, transport: transport!.descriptor, providerModule: pathToFileURL(path.join(options.temporary, 'provider.mjs')).href } satisfies ChildStartup });
      });
    }
    const proxy = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 }); apps.push(proxy);
    proxy.removeAllContentTypeParsers(); proxy.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 4 * 1024 * 1024 }, (_request, body, done) => done(null, body));
    proxy.all('/*', async (request, reply) => {
      const instance = nextInstance(); return new Promise<void>((resolve) => {
        const forwarded = httpRequest({ hostname: '127.0.0.1', port: ports[instance], method: request.method, path: request.raw.url, headers: { ...request.headers, host: `127.0.0.1:${ports[instance]}` } }, response => {
          requests.push({ instance, method: request.method, path: request.url.split('?')[0]!, status: response.statusCode ?? 0,
            ...(typeof request.headers['idempotency-key'] === 'string' ? { operationKey: request.headers['idempotency-key'] } : {}) }); if (requests.length > 1000) requests.shift();
          // Keep cutting matching acknowledgements until explicitly cleared: Chromium may transparently retry a closed connection.
          if (dropResponse && request.method === dropResponse.method && request.url.split('?')[0]!.endsWith(dropResponse.pathEndsWith)) { response.resume(); response.once('end', () => { reply.hijack(); reply.raw.destroy(); resolve(); }); return; }
          reply.code(response.statusCode ?? 502); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && !['connection','transfer-encoding','keep-alive'].includes(key)) reply.header(key, value);
          reply.header('X-CE-Test-Instance', instance); reply.send(response); resolve();
        });
        forwarded.once('error', () => { if (!reply.sent) reply.code(502).send({ error: 'CONTROLLED_UPSTREAM_UNAVAILABLE' }); resolve(); });
        if (Buffer.isBuffer(request.body)) forwarded.end(request.body); else forwarded.end();
      });
    });
    await proxy.listen({ host: '127.0.0.1', port: ports.publicApi });
    const frontend = Fastify({ logger: false }), webRoot = path.resolve(options.webRoot ?? path.join(options.root, 'dist/web/browser')); apps.push(frontend);
    const original = await readFile(path.join(webRoot, 'index.html'), 'utf8');
    if (original.includes('ce-public-config') || !original.includes('</head>')) throw new Error('Use the plain Angular build for the test frontend');
    const html = original.replace('</head>', `<script type="application/json" id="ce-public-config">${JSON.stringify({ apiBaseUrl: origin(ports.publicApi), deploymentProfile: 'hosted-e2e' })}</script></head>`);
    await frontend.register(fastifyStatic, { root: webRoot, index: false, dotfiles: 'ignore' }); frontend.get('/', (_request, reply) => reply.type('text/html').send(html));
    frontend.setNotFoundHandler((request, reply) => { const pathname = request.url.split('?')[0]!; return request.method === 'GET' && request.headers.accept?.includes('text/html') && !pathname.startsWith('/api/') && !pathname.split('/').some(segment => segment.includes('.')) ? reply.type('text/html').send(html) : reply.code(404).send({ error: 'NOT_FOUND' }); });
    frontend.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); }); await frontend.listen({ host: '127.0.0.1', port: ports.frontend });
    const control = Fastify({ logger: false }); apps.push(control);
    control.get('/', (_request, reply) => reply.type('text/html').send('<!doctype html><title>Third origin test</title><p>Controlled disallowed origin</p>'));
    control.addHook('onRequest', async (request, reply) => { if (request.url !== '/' && request.headers['x-ce-test-control'] !== options.controlToken) return reply.code(403).send({ error: 'FORBIDDEN' }); });
    control.get('/state', async () => ({ instances: children.map((child, i) => ({ instance: i ? 'api2' : 'api1', pid: child.pid, alive: child.exitCode === null })), balancing, paused: queuePaused, queued: queue.length, deliveries, requests,
      jobCounts: (await db.query('SELECT workspace_id AS "workspaceId",kind,count(*)::integer AS count FROM jobs GROUP BY workspace_id,kind')).rows }));
    control.post<{ Body: { instance: 'auto'|'api1'|'api2' } }>('/balance', async request => { if (!['auto','api1','api2'].includes(request.body.instance)) throw new Error('Invalid test instance'); balancing = request.body.instance; return { balancing }; });
    control.post<{ Body: { paused?: boolean; loseNextAck?: boolean } }>('/queue', async request => { if (typeof request.body.paused === 'boolean') queuePaused = request.body.paused; if (request.body.loseNextAck) loseNextQueueAck = true; pump(); return { paused: queuePaused }; });
    control.post<{ Body: { method: string; pathEndsWith: string } }>('/drop-response', async request => { if (!['POST','PATCH','DELETE'].includes(request.body.method) || !/^\/[a-z][a-z-]*$/.test(request.body.pathEndsWith)) throw new Error('Invalid test failure selector'); dropResponse = request.body; return { armed: true }; });
    control.post('/drop-response/clear', async () => { dropResponse = null; return { armed: false }; });
    await control.listen({ host: '127.0.0.1', port: ports.control });
    return { frontendOrigin: origin(ports.frontend), apiOrigin: origin(ports.publicApi), controlOrigin: origin(ports.control), schema, close };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
