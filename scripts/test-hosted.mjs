import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const ownership = randomUUID();
const image = 'postgres@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f';
let containerId, child, interrupted = false;
async function docker(args, options = {}) {
  return execute('docker', args, { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, ...options });
}
async function provision() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  try { await docker(['info', '--format', '{{.ServerVersion}}']); }
  catch { throw new Error('Hosted tests require a reachable PostgreSQL 17 TEST_DATABASE_URL or Docker Desktop. No SQL mock or skipped PASS is available.'); }
  const password = randomBytes(32).toString('base64url');
  try {
    const result = await docker(['run', '--detach', '--rm', '--pull=never', '--name', `ce-hosted-${ownership}`,
      '--label', `ce.hosted-test-owner=${ownership}`, '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=ce_test', '--env', 'POSTGRES_DB=ce_test', image],
    { env: { ...process.env, POSTGRES_PASSWORD: password } });
    containerId = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error();
    const endpoint = (await docker(['port', containerId, '5432/tcp'])).stdout.trim();
    if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error();
    for (let attempts = 0; attempts < 60; attempts++) {
      try { await docker(['exec', containerId, 'pg_isready', '--username=ce_test', '--dbname=ce_test']);
        console.log('Hosted tests: owned PostgreSQL 17 container ready; each suite uses an isolated schema.');
        return `postgresql://ce_test:${password}@${endpoint}/ce_test`;
      } catch { await delay(250); }
    }
  } catch { throw new Error('Could not prepare the owned PostgreSQL 17 test container. Install/pull the pinned image or provide TEST_DATABASE_URL.'); }
  throw new Error('Owned PostgreSQL 17 did not become ready within the test startup deadline.');
}
async function cleanup() {
  if (!containerId) return;
  const owner = (await docker(['inspect', '--format', '{{index .Config.Labels "ce.hosted-test-owner"}}', containerId])).stdout.trim();
  if (owner !== ownership) throw new Error('Refusing to remove a container without the exact test ownership label.');
  await docker(['stop', '--time', '5', containerId]);
  console.log('Hosted tests: owned PostgreSQL container removed.');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; child?.kill('SIGTERM'); });
try {
  const databaseUrl = await provision();
  if (interrupted) throw new Error('Hosted tests interrupted.');
  child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'hosted', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} catch (error) { console.error(error instanceof Error ? error.message : 'Hosted test setup failed.'); process.exitCode = 1; }
finally { try { await cleanup(); } catch { console.error('Owned test-container cleanup failed. Inspect the ce.hosted-test-owner label before manual removal.'); process.exitCode = 1; } }
if (interrupted) process.exitCode = 130;
