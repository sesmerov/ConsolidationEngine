import { createHash, createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { QstashDispatcher, QstashSignatureVerifier } from '../../apps/api/src/hosted/qstash-dispatcher.js';
import { registerInternalJobs } from '../../apps/api/src/routes/internal-jobs.js';
import type { JobDTO } from '@ce/contracts';

const origin = 'https://api.example.test', currentKey = 'synthetic-current-signing-key', nextKey = 'synthetic-next-signing-key';
const reference = () => ({ sessionId: randomUUID(), workspaceId: randomUUID(), jobId: randomUUID() });
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function signature(body: string, key = currentKey, url = origin + '/internal/jobs', expires = Math.floor(Date.now() / 1000) + 60) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'Upstash', sub: url, exp: expires, nbf: Math.floor(Date.now() / 1000) - 1,
    body: createHash('sha256').update(body).digest('base64url') })).toString('base64url');
  return `${head}.${payload}.${createHmac('sha256', key).update(`${head}.${payload}`).digest('base64url')}`;
}
async function setup(run = vi.fn().mockResolvedValue({ state: 'terminal', job: { status: 'succeeded' } as JobDTO })) {
  const app = Fastify({ logger: false }); apps.push(app);
  registerInternalJobs(app, { publicApiOrigin: origin, verifier: new QstashSignatureVerifier(currentKey, nextKey), run });
  await app.ready(); return { app, run };
}
it('publishes only accepted references, bounds deliveries and suppresses hidden SDK retries/dev URLs', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: 'controlled-id' }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const dispatcher = new QstashDispatcher({ publicApiOrigin: origin, token: 'synthetic-token' }), input = reference();
  await dispatcher.dispatch(input);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(String(url)).toBe('https://qstash.upstash.io/v2/publish/' + origin + '/internal/jobs');
  expect(JSON.parse(init.body)).toEqual(input);
  const headers = new Headers(init.headers);
  expect(headers.get('upstash-retries')).toBe('3'); expect(headers.get('upstash-timeout')).toBe('120s');
  expect(headers.get('upstash-flow-control-key')).toMatch(/^ce-cpu-/);
  expect(headers.get('upstash-flow-control-value')).toBe('parallelism=1');
  expect(headers.get('upstash-retry-delay')).toBe('1000 * pow(2, retried)');
  expect(init.signal).toBeInstanceOf(AbortSignal);expect(init.redirect).toBe('error');
  fetch.mockRejectedValue(new Error('lost provider acknowledgement'));
  await expect(dispatcher.dispatch(input)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(2);
});
it('aborts a hung publication at the client boundary and does not start a hidden retry',async()=>{
 const timeout=AbortSignal.timeout.bind(AbortSignal),spy=vi.spyOn(AbortSignal,'timeout').mockImplementation(()=>timeout(5));
 const fetch=vi.fn((_url:string,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});}));vi.stubGlobal('fetch',fetch);
 await expect(new QstashDispatcher({publicApiOrigin:origin,token:'synthetic-token'}).dispatch(reference())).rejects.toThrow();
 expect(spy).toHaveBeenCalledWith(10000);expect(fetch).toHaveBeenCalledTimes(1);
});
it('uses actual current and next signature keys over exact raw body and public URL', async () => {
  const { app, run } = await setup(), input = reference(), body = `\n ${JSON.stringify(input, null, 2)} \n`;
  for (const key of [currentKey, nextKey]) {
    const response = await app.inject({ method: 'POST', url: '/internal/jobs', headers: { 'content-type': 'application/json', 'upstash-signature': signature(body, key), host: 'untrusted-host.invalid' }, payload: body });
    expect(response.statusCode, response.body).toBe(200);
  }
  expect(run).toHaveBeenCalledTimes(2); expect(run).toHaveBeenLastCalledWith(input);
});
it('rejects invalid authentication before JSON parsing and rejects altered bytes, URL and expired signatures', async () => {
  const { app, run } = await setup(), body = JSON.stringify(reference());
  for (const [raw, signed] of [['not json', undefined], ['not json', 'forged'], [body + ' ', signature(body)],
    [body, signature(body, currentKey, origin + '/internal/maintenance')], [body, signature(body, currentKey, undefined, 1)]] as const) {
    const response = await app.inject({ method: 'POST', url: '/internal/jobs', headers: { 'content-type': 'application/json', ...(signed ? { 'upstash-signature': signed } : {}), 'x-ce-session': 'not-internal-auth' }, payload: raw });
    expect(response.statusCode, response.body).toBe(401); expect(response.body).not.toContain(raw);
  }
  expect(run).not.toHaveBeenCalled();
});
it('rejects signed malformed, oversized or data-bearing messages without invoking the worker', async () => {
  const { app, run } = await setup();
  for (const body of ['{', JSON.stringify({ ...reference(), facts: [] }), JSON.stringify({ ...reference(), jobId: '../wrong' })]) {
    const response = await app.inject({ method: 'POST', url: '/internal/jobs', headers: { 'content-type': 'application/json', 'upstash-signature': signature(body) }, payload: body });
    expect(response.statusCode).toBe(400);
  }
  const large = ' '.repeat(4097);
  expect((await app.inject({ method: 'POST', url: '/internal/jobs', headers: { 'content-type': 'application/json', 'upstash-signature': signature(large) }, payload: large })).statusCode).toBe(413);
  expect(run).not.toHaveBeenCalled();
});
it('awaits durable terminal result and returns a retryable response while authority is busy', async () => {
  let release!: (value: unknown) => void;
  const run = vi.fn().mockImplementation(() => new Promise(resolve => { release = resolve; })), { app } = await setup(run), body = JSON.stringify(reference());
  let answered = false;
  const pending = app.inject({ method: 'POST', url: '/internal/jobs', headers: { 'content-type': 'application/json', 'upstash-signature': signature(body) }, payload: body }).then(value => { answered = true; return value; });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1)); expect(answered).toBe(false);
  release({ state: 'terminal', job: { status: 'succeeded' } }); expect((await pending).statusCode).toBe(200);
  run.mockResolvedValueOnce({ state: 'busy', retryAfterMs: 1500 });
  const busy = await app.inject({ method: 'POST', url: '/internal/jobs', headers: { 'content-type': 'application/json', 'upstash-signature': signature(body) }, payload: body });
  expect(busy.statusCode).toBe(503); expect(busy.headers['retry-after']).toBe('2');
  run.mockResolvedValueOnce({ state: 'terminal', job: { status: 'running' } });
  expect((await app.inject({ method: 'POST', url: '/internal/jobs', headers: { 'content-type': 'application/json', 'upstash-signature': signature(body) }, payload: body })).statusCode).toBe(500);
});
