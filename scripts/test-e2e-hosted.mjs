import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { assertPackageToolchain, executePackageNpm } from './lib/package-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), ownership = randomUUID(), execute = promisify(execFile);
const image = 'postgres@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f';
const temporary = path.join(root, '.tools', `hosted-e2e-${ownership}`), controlToken = randomBytes(32).toString('base64url');
const args = process.argv.slice(2), skipBuild = args.includes('--no-build');
let containerId, creationAttempted = false, child, server, interrupted = false, ownedTemporary = false;
const docker = (args, options = {}) => execute('docker', args, { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, ...options });
async function database() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  await docker(['info', '--format', '{{.ServerVersion}}']); const password = randomBytes(32).toString('base64url'); creationAttempted = true;
  const result = await docker(['run', '--detach', '--rm', '--pull=never', '--name', `ce-e2e-${ownership}`, '--label', `ce.hosted-e2e-owner=${ownership}`, '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=ce_test', '--env', 'POSTGRES_DB=ce_test', image], { env: { ...process.env, POSTGRES_PASSWORD: password } });
  containerId = result.stdout.trim(); if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Invalid owned container identity');
  const endpoint = (await docker(['port', containerId, '5432/tcp'])).stdout.trim(); if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Invalid owned database endpoint');
  for (let attempt = 0; attempt < 60; attempt++) {
    // The entrypoint briefly starts a Unix-socket-only server while initializing the data directory.
    // Require TCP readiness so migration never races that temporary server's shutdown.
    try { await docker(['exec', containerId, 'pg_isready', '--host=127.0.0.1', '--username=ce_test', '--dbname=ce_test']); console.log('Hosted E2E: owned PostgreSQL 17 ready. Queue/signature/Blob transports are controlled test adapters.'); return `postgresql://ce_test:${password}@${endpoint}/ce_test`; }
    catch { await delay(250); }
  }
  throw new Error('Owned PostgreSQL did not become ready');
}
async function cleanupDatabase() {
  if (!containerId && creationAttempted) {
    try { const [id, owner] = (await docker(['inspect', '--format', '{{.Id}} {{index .Config.Labels "ce.hosted-e2e-owner"}}', `ce-e2e-${ownership}`])).stdout.trim().split(' ');
      if (owner !== ownership || !/^[a-f0-9]{64}$/.test(id ?? '')) throw new Error('Test container ownership mismatch'); containerId = id;
    } catch (error) { if (/No such (object|container)/i.test(String(error?.stderr ?? ''))) return; throw error; }
  }
  if (!containerId) return;
  const owner = (await docker(['inspect', '--format', '{{index .Config.Labels "ce.hosted-e2e-owner"}}', containerId])).stdout.trim(); if (owner !== ownership) throw new Error('Refusing to remove another container');
  await docker(['stop', '--time', '5', containerId]); console.log('Hosted E2E: owned PostgreSQL container removed.');
}
async function preserveEvidence() {
  const output = path.join(root, 'outputs', `hosted-e2e-${ownership}`); await mkdir(output, { recursive: false });
  const result = JSON.parse(await readFile(path.join(root, 'test-results/hosted-results.json'), 'utf8'));
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  const downloads = [];
  async function collect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, item.name);
      if (item.isDirectory()) await collect(source);
      else if (item.isFile() && /^(visitor-\d+-report|(?:corep|types)-hosted-report)\.zip$/.test(item.name)) {
        await cp(source, path.join(output, item.name), { errorOnExist: true, force: false }); downloads.push(item.name);
      }
    }
  }
  await collect(path.join(root, 'test-results/hosted'));
  await writeFile(path.join(output, 'run.json'), JSON.stringify({ schemaVersion: 1, status: process.exitCode === 0 ? 'pass' : 'failed',
    actors: 'Playwright Chromium and two independent API processes', database: 'real PostgreSQL 17',
    providers: 'controlled queue, HMAC verification and private file transport', publicApiUrl: 'http://127.0.0.1:3351',
    humanAcceptance: false, arguments: args, downloads }, null, 2));
  console.log(`Hosted E2E evidence: ${output}`);
}
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { interrupted = true; child?.kill('SIGTERM'); });
try {
  if (!skipBuild) { const options = { root, environment: process.env }; await assertPackageToolchain(executePackageNpm, options); await executePackageNpm(['run','build:api'], options); await executePackageNpm(['run','build','--workspace','@ce/web'], options); }
  await mkdir(temporary, { recursive: false }); ownedTemporary = true; await writeFile(path.join(temporary, '.ce-e2e-owner'), ownership, { flag: 'wx' });
  await build({ entryPoints: { server: 'tests/helpers/hosted-e2e-server.ts', provider: 'tests/helpers/controlled-file-objects.ts' }, absWorkingDir: root, outdir: temporary, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
  const databaseUrl = await database(); if (interrupted) throw new Error('Hosted E2E interrupted');
  const module = await import(pathToFileURL(path.join(temporary, 'server.mjs')).href);
  server = await module.startHostedE2eServer({ root, temporary, databaseUrl, controlToken });
  console.log('Hosted E2E: frontend :3350 → public API :3351 → independent API processes :3352/:3353.');
  child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/e2e/hosted.config.ts', ...args.filter(arg => arg !== '--no-build')], {
    cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, CE_E2E_CONTROL_TOKEN: controlToken, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(root, '.cache/playwright') },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  await preserveEvidence();
} catch (error) { console.error(error instanceof Error ? error.message : 'Hosted E2E failed'); process.exitCode = 1; }
finally {
  try { await server?.close(); } catch { console.error('Owned E2E API/schema cleanup failed'); process.exitCode = 1; }
  try { await cleanupDatabase(); } catch { console.error('Owned container cleanup failed; inspect its exact ce.hosted-e2e-owner label before manual cleanup'); process.exitCode = 1; }
  if (ownedTemporary) try {
    const resolved = await realpath(temporary), parent = await realpath(path.join(root, '.tools'));
    if (path.dirname(resolved) !== parent || path.basename(resolved) !== `hosted-e2e-${ownership}` || await readFile(path.join(resolved, '.ce-e2e-owner'), 'utf8') !== ownership) throw new Error('Temporary ownership mismatch');
    await rm(resolved, { recursive: true, force: false });
  } catch { console.error('Owned E2E temporary cleanup failed'); process.exitCode = 1; }
}
if (interrupted) process.exitCode = 130;
