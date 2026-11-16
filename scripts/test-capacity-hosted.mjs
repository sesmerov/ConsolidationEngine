import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { LINUX_IMAGE } from './test-package-linux.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), execute = promisify(execFile), MiB = 1024 ** 2;
const PG_IMAGE = 'postgres@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f';
const docker = (args, options = {}) => execute('docker', args, { cwd: root, windowsHide: true, timeout: 900_000, maxBuffer: 32 * MiB, ...options });
function input(name) { const parts = name.replaceAll('\\', '/').split('/'); return !parts.some(part => ['node_modules','dist','build','.angular','.git','.cache','.tools','.vercel','.vercel-dist','outputs','playwright-report','test-results','.agents','.codex','.codegraph','.aws','.azure','.gcloud','.ssh'].includes(part) || part.startsWith('.env') || part.endsWith('.log') || part.endsWith('.tsbuildinfo')); }
async function prepare() {
  const { build } = await import('esbuild'); await mkdir('.tools/capacity', { recursive: true });
  await build({ entryPoints: { fixtures: 'tests/helpers/hosted-capacity-fixtures.ts', provider: 'tests/helpers/controlled-file-objects.ts', command: 'tests/helpers/hosted-capacity-command.ts' }, outdir: '.tools/capacity', outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', format: 'esm' });
  const { createCapacityFixtures, createExportCapacityFixtures } = await import(pathToFileURL(resolve('.tools/capacity/fixtures.mjs')).href); await createCapacityFixtures('/inputs'); await createExportCapacityFixtures('/inputs/export');
}
async function treeBytes(directory) {
  let total = 0; for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const name = join(directory, entry.name); if (entry.isDirectory()) total += await treeBytes(name); else if (entry.isFile()) total += (await stat(name).catch(() => ({ size: 0 }))).size;
  } return total;
}
async function sample() {
  let rss = 0, processes = 0;
  for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
    const status = await readFile(`/proc/${name}/status`, 'utf8').catch(() => ''); const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (value) { rss += Number(value[1]) * 1024; processes++; }
  }
  return { rssBytes: rss, processes, temporaryBytes: await treeBytes('/tmp') };
}
async function inside() {
  assert.equal(process.platform, 'linux'); assert.equal(process.version, 'v24.22.2');
  const diagnostic = process.argv.includes('--diagnose-validation'), selectedTests = process.argv.slice(2).filter(arg => !['--inside','--diagnose-validation'].includes(arg));
  if (diagnostic) selectedTests.push('-t', 'admitted');
  const sourceFiles = ['scripts/test-capacity-hosted.mjs','tests/performance/hosted-capacity.spec.ts','tests/helpers/hosted-capacity-fixtures.ts','tests/helpers/hosted-capacity-command.ts','apps/api/src/hosted/snapshot-codec.ts','apps/api/src/hosted/canonical-codec.ts','apps/api/src/hosted/worker-runner.ts','apps/api/src/hosted/domain-commands.ts','apps/api/src/hosted/projection-store.ts','apps/api/src/hosted/transfer-commands.ts','apps/api/src/export/recalculated-report.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));
  const evidence = { schemaVersion: 1, status: 'running', diagnostic, diagnosticScope: diagnostic ? 'One maximum snapshot seeds phase timing for validation only. Does not satisfy the twenty-snapshot gate.' : undefined, runNote: process.env.CAPACITY_RUN_NOTE ?? null, selectedTests, sourceHashes, node: process.version, platform: process.platform, architecture: process.arch,
    image: LINUX_IMAGE, database: { image: PG_IMAGE, authority: 'real PostgreSQL 17; separate container' },
    providers: 'controlled filesystem object transport and queue; no real cloud services',
    constraints: { memoryBytes: 2 * 1024 ** 3, cpuQuota: 1, rssLimitBytes: Math.floor(1.6 * 1024 ** 3), tmpLimitBytes: 400 * MiB, workerOldHeapMiB: 256, jobDeadlineMs: 60_000 },
    measurement: { scope: 'Sum of VmRSS for every process in application PID namespace; threads counted once in process RSS. PostgreSQL and private object storage represent external services. /tmp includes all application temporaries.', sampleIntervalMs: 50, samples: 0, maxRssBytes: 0, maxTmpBytes: 0, maxProcesses: 0 },
    cgroup: { memoryMax: (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(), cpuMax: (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim() }, startedAt: new Date().toISOString() };
  assert.equal(Number(evidence.cgroup.memoryMax), evidence.constraints.memoryBytes);
  const [quota, period] = evidence.cgroup.cpuMax.split(' ').map(Number); assert.equal(quota / period, 1);
  const output = '/evidence'; await mkdir(output, { recursive: true }); await cp('/inputs/manifest.json', join(output, 'inputs.json')); await cp('/inputs', join(output, 'inputs'), { recursive: true });
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/performance/hosted-capacity.config.ts', '--reporter=json', '--outputFile=/evidence/vitest.json', ...selectedTests], { cwd: root, env: { ...process.env, CAPACITY_EVIDENCE: output, ...(diagnostic ? { CAPACITY_DIAGNOSTIC: 'validation' } : {}) }, stdio: 'inherit' });
  let stopped = false; const monitoring = (async () => { while (!stopped) { const value = await sample(), metrics = evidence.measurement; metrics.samples++; metrics.maxRssBytes = Math.max(metrics.maxRssBytes, value.rssBytes); metrics.maxTmpBytes = Math.max(metrics.maxTmpBytes, value.temporaryBytes); metrics.maxProcesses = Math.max(metrics.maxProcesses, value.processes); await writeFile(join(output, 'resources.json'), JSON.stringify(evidence, null, 2)); await delay(50); } })();
  const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', code => resolveCode(code ?? 1)); }); stopped = true; await monitoring;
  evidence.completedAt = new Date().toISOString(); evidence.testExitCode = code; evidence.cgroup.memoryPeakBytes = Number(await readFile('/sys/fs/cgroup/memory.peak', 'utf8'));
  evidence.cgroup.memoryEvents = (await readFile('/sys/fs/cgroup/memory.events', 'utf8')).trim();
  evidence.status = code === 0 && evidence.measurement.maxRssBytes <= evidence.constraints.rssLimitBytes && evidence.measurement.maxTmpBytes <= evidence.constraints.tmpLimitBytes ? diagnostic ? 'diagnostic-only' : 'pass' : 'failed';
  await writeFile(join(output, 'resources.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = ['pass','diagnostic-only'].includes(evidence.status) ? 0 : 1;
}
async function outside() {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  const owner = randomUUID(), context = join(root, '.cache', 'capacity-' + owner), image = 'ce-capacity:' + owner;
  const network = 'ce-capacity-' + owner, pg = network + '-pg', app = network + '-app', output = join(root, 'outputs', 'capacity-hosted-' + owner);
  const label = 'ce.capacity-owner', password = randomBytes(32).toString('base64url');
  await mkdir(join(context, 'project'), { recursive: true }); await mkdir(output, { recursive: true });
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) if (input(entry.name)) await cp(join(root, entry.name), join(context, 'project', entry.name), { recursive: true, filter: source => input(relative(root, source)) });
    await writeFile(join(context, 'Dockerfile'), `FROM ${LINUX_IMAGE}\nWORKDIR /app\nCOPY project/package.json project/package-lock.json project/.npmrc ./\nCOPY project/apps/api/package.json apps/api/package.json\nCOPY project/apps/web/package.json apps/web/package.json\nCOPY project/packages/contracts/package.json packages/contracts/package.json\nCOPY project/packages/engine/package.json packages/engine/package.json\nRUN npm ci\nCOPY project/ ./\nRUN npm run build:api\nRUN node scripts/test-capacity-hosted.mjs --prepare\nCMD ["node","scripts/test-capacity-hosted.mjs","--inside"]\n`);
    console.log(`Preparing Linux capacity test; evidence: ${output}`);
    try { const built = await docker(['build', '--label', `${label}=${owner}`, '--tag', image, context]); await writeFile(join(output, 'build.log'), built.stdout + built.stderr); }
    catch (error) { await writeFile(join(output, 'build.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    await docker(['network', 'create', '--internal', '--label', `${label}=${owner}`, network]);
    await docker(['run', '--detach', '--name', pg, '--network', network, '--network-alias', 'database', '--label', `${label}=${owner}`, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=ce_test', '--env', 'POSTGRES_DB=ce_test', PG_IMAGE], { env: { ...process.env, POSTGRES_PASSWORD: password } });
    // initdb briefly starts a Unix-socket-only server; only TCP readiness proves the final server is ready.
    for (let attempt = 0; ; attempt++) { try { await docker(['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'ce_test', '-d', 'ce_test']); break; } catch { if (attempt >= 59) throw new Error('PostgreSQL did not become ready'); await delay(250); } }
    const databaseVersion = await docker(['exec', pg, 'psql', '-h', '127.0.0.1', '-U', 'ce_test', '-d', 'ce_test', '-tAc', 'SELECT version()']);
    await writeFile(join(output, 'database.json'), JSON.stringify({ postgres: databaseVersion.stdout.trim(), scope: 'Real separate PostgreSQL server; no cloud provider integration' }, null, 2));
    const forwarded = process.argv.slice(2), environment = { ...process.env, TEST_DATABASE_URL: `postgresql://ce_test:${password}@127.0.0.1:5432/ce_test` };
    // Share only PostgreSQL's network namespace, so the test-only plaintext connection stays loopback.
    // PID namespaces and memory/CPU cgroups remain separate; no host port is published.
    try { const result = await docker(['run', '--name', app, '--label', `${label}=${owner}`, '--network', `container:${pg}`, '--memory', '2g', '--memory-swap', '2g', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,size=400m', '--mount', `type=bind,source=${output},target=/evidence`, '--env', 'TEST_DATABASE_URL', '--env', 'CAPACITY_RUN_NOTE', image, 'node', 'scripts/test-capacity-hosted.mjs', '--inside', ...forwarded], { env: environment }); await writeFile(join(output, 'runtime.log'), result.stdout + result.stderr); }
    catch (error) { await writeFile(join(output, 'runtime.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
  } finally {
    for (const name of [app, pg]) { const found = await docker(['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name]).catch(() => null); if (found?.stdout.trim() === owner) await docker(['rm', '--force', name]); }
    const net = await docker(['network', 'inspect', '--format', `{{index .Labels "${label}"}}`, network]).catch(() => null); if (net?.stdout.trim() === owner) await docker(['network', 'rm', network]);
    const built = await docker(['image', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, image]).catch(() => null); if (built?.stdout.trim() === owner) await docker(['image', 'rm', image]);
    if (relative(join(root, '.cache'), resolve(context)) === 'capacity-' + owner) await rm(context, { recursive: true, force: true }); console.log(`Capacity evidence retained: ${output}`);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  (process.argv.includes('--prepare') ? prepare : process.argv.includes('--inside') ? inside : outside)().catch(error => { console.error(error instanceof Error ? error.message : 'Capacity gate failed'); process.exitCode = 1; });
}
