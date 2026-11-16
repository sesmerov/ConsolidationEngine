import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { executePackageNpm } from './lib/package-build.mjs';
import { packageApi } from './package-vercel-api.mjs';
import { packageWeb } from './package-vercel-web.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const LINUX_IMAGE = 'node@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9';
export const GENERATED_PARSER_FILES = Object.freeze(['dpm_xlLexer.interp', 'dpm_xlLexer.js', 'dpm_xlLexer.tokens',
  'dpm_xlParser.interp', 'dpm_xlParser.js', 'dpm_xlParser.tokens', 'dpm_xlParserVisitor.js', 'generation-manifest.json']);

export function allowedBuildInput(name) {
  const normalized = name.replaceAll('\\', '/'), segments = normalized.split('/');
  if (segments.some(part => ['node_modules', 'dist', 'build', '.angular', '.vercel', '.vercel-dist', '.git', '.cache', '.tools'].includes(part)
    || part.startsWith('.env') || part.endsWith('.log') || part.endsWith('.tsbuildinfo'))) return false;
  if (['apps', 'packages', 'scripts', 'grammar', 'assets'].includes(segments[0])) return true;
  return ['package.json', 'package-lock.json', '.npmrc', 'tsconfig.base.json',
    'tests', 'tests/fixtures', 'tests/fixtures/eba', '(from 4.0) EBA_Validation_rules_2025-12-12.xlsx'].includes(normalized)
    || normalized.startsWith('tests/fixtures/eba/');
}

export function packageDockerfile() {
  return `FROM ${LINUX_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY project/ /build/
RUN test "$(node --version)" = "v24.22.2" && test "$(npm --version)" = "11.19.1" && npm ci
RUN npm run test:package:linux -- --inside-build
FROM ${LINUX_IMAGE} AS runtime
WORKDIR /app
COPY --from=build /build/.cache/linux-runtime/ /app/
USER node
CMD ["node", "scripts/smoke-package.mjs"]
`;
}

export async function compareGeneratedParser(first, second) {
  const expected = [...GENERATED_PARSER_FILES].sort();
  assert.deepEqual((await readdir(first)).sort(), expected, 'Expected exactly eight generated parser files.');
  assert.deepEqual((await readdir(second)).sort(), expected, 'Expected exactly eight reproduced parser files.');
  const files = [];
  for (const name of expected) {
    const original = await readFile(join(first, name)), reproduced = await readFile(join(second, name));
    assert.equal(sha256(original), sha256(reproduced), `Non-reproducible generated file: ${name}`);
    files.push({ name, sha256: sha256(original), bytes: original.length });
  }
  return files;
}

async function originalHashes(project) {
  const antlr = JSON.parse(await readFile(join(project, 'scripts/antlr-toolchain.json'), 'utf8'));
  const sources = JSON.parse(await readFile(join(project, 'tests/fixtures/eba/source-manifest.json'), 'utf8'));
  const demo = JSON.parse(await readFile(join(project, 'assets/demos/source-data.json'), 'utf8'));
  const expected = [
    { path: `.tools/antlr-${antlr.version}-complete.jar`, sha256: antlr.sha256 },
    ...Object.entries(antlr.grammars).map(([name, hash]) => ({ path: `grammar/${name}`, sha256: hash })),
    ...sources.sources.map(source => ({ path: `tests/fixtures/eba/${source.file}`, sha256: source.sha256 })),
    { path: demo.sourceName, sha256: demo.sourceSha256 },
  ];
  for (const source of expected) {
    assert.equal(sha256(await readFile(join(project, source.path))), source.sha256, `Original input checksum changed: ${source.path}`);
  }
  return expected;
}

async function treeFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) output.push(...await treeFiles(join(directory, entry.name)));
    else if (entry.isFile()) output.push(join(directory, entry.name));
    else throw new Error('Package build inputs must not contain symbolic links or special files.');
  }
  return output;
}

async function insideBuild() {
  assert.equal(process.platform, 'linux'); assert.equal(process.version, 'v24.22.2');
  const originals = await originalHashes(root);
  const sentinels = { DATABASE_URL: 'CE_PACKAGE_SECRET_DATABASE', BLOB_READ_WRITE_TOKEN: 'CE_PACKAGE_SECRET_BLOB',
    QSTASH_TOKEN: 'CE_PACKAGE_SECRET_QSTASH', QSTASH_CURRENT_SIGNING_KEY: 'CE_PACKAGE_SECRET_QUEUE_CURRENT',
    QSTASH_NEXT_SIGNING_KEY: 'CE_PACKAGE_SECRET_QUEUE_NEXT', CE_CURSOR_SIGNING_KEY: 'CE_PACKAGE_SECRET_CURSOR' };
  const environment = { ...process.env, ...sentinels, API_BASE_URL: 'https://api.example.test', DEPLOYMENT_PROFILE: 'demo-public' };
  const web = await packageWeb({ root, environment }), api = await packageApi({ root, environment });
  // Preserve the separate local build used by README's npm start, alongside the Vercel web artifact.
  await executePackageNpm(['run', 'build', '--workspace', '@ce/web'], { root, environment });
  const localWeb = join(root, 'dist/web/browser');
  const reproduction = '.cache/antlr-reproduction';
  await executePackageNpm(['run', 'generate:parser', '--', '--output', reproduction], { root, environment });
  const parser = await compareGeneratedParser(join(root, 'packages/engine/src/generated'), join(root, reproduction));
  assert.deepEqual(await originalHashes(root), originals);
  for (const filename of [...await treeFiles(web.outputDirectory), ...await treeFiles(localWeb)]) {
    const bytes = await readFile(filename);
    for (const value of Object.values(sentinels)) assert.ok(!bytes.includes(Buffer.from(value)), 'Provider secret leaked into frontend.');
  }
  const runtime = join(root, '.cache/linux-runtime');
  await mkdir(runtime, { recursive: true });
  const copies = ['package.json', 'package-lock.json', '.npmrc', 'apps/api/package.json', 'apps/web/package.json',
    'packages/contracts/package.json', 'packages/engine/package.json', 'apps/api/api', 'apps/api/dist',
    'packages/contracts/dist', 'packages/engine/dist', 'dist/web/browser', 'scripts/smoke-package.mjs'];
  for (const item of copies) {
    await mkdir(dirname(join(runtime, item)), { recursive: true });
    await cp(join(root, item), join(runtime, item), { recursive: true });
  }
  await cp(web.outputDirectory, join(runtime, 'web'), { recursive: true });
  await executePackageNpm(['ci', '--omit=dev', '--workspace=@ce/api', '--include-workspace-root=false', '--ignore-scripts'], { root: runtime, environment });
  const java = await execute('java', ['-version']);
  const evidence = { schemaVersion: 1, platform: process.platform, architecture: process.arch, node: process.version,
    npm: await executePackageNpm(['--version'], { root, environment }), java: (java.stderr + java.stdout).trim(), originals, parser,
    apiRuntime: JSON.parse(await readFile(api.manifestPath, 'utf8')), frontendSecretScan: 'pass',
    scope: 'Portable compiled application; hosted provider integration and Vercel generated function trace are separate gates.' };
  await writeFile(join(runtime, 'package-evidence.json'), JSON.stringify(evidence, null, 2));
}

async function docker(args, options = {}) {
  return execute('docker', args, { cwd: root, windowsHide: true, timeout: 600_000, maxBuffer: 32 * 1024 * 1024, ...options });
}

async function outsideBuild() {
  try { await access(join(root, 'apps/api/api/index.ts')); await access(join(root, 'apps/api/src/hosted-entry.ts')); }
  catch { throw new Error('Complete T087 hosted entry before running the Linux package gate.'); }
  await originalHashes(root);
  await docker(['info', '--format', '{{.ServerVersion}}']);
  const ownership = randomUUID(), context = join(root, '.cache', `package-linux-${ownership}`), project = join(context, 'project');
  const image = `ce-package-linux:${ownership}`, name = `ce-package-linux-${ownership}`;
  const output = join(root, 'outputs', `package-linux-${ownership}`);
  await mkdir(project, { recursive: true }); await mkdir(output, { recursive: true });
  let built = false, attemptedRun = false;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!allowedBuildInput(entry.name)) continue;
      await cp(join(root, entry.name), join(project, entry.name), { recursive: true,
        filter: source => allowedBuildInput(relative(root, source)) });
    }
    const antlr = JSON.parse(await readFile(join(root, 'scripts/antlr-toolchain.json'), 'utf8'));
    await mkdir(join(project, '.tools'), { recursive: true });
    await cp(join(root, `.tools/antlr-${antlr.version}-complete.jar`), join(project, `.tools/antlr-${antlr.version}-complete.jar`));
    await writeFile(join(context, 'Dockerfile'), packageDockerfile());
    console.log('Building an isolated Linux application package; source, build and runtime trees remain separate.');
    try {
      const result = await docker(['build', '--label', `ce.package-owner=${ownership}`, '--tag', image, context]);
      await writeFile(join(output, 'build.log'), result.stdout + result.stderr); built = true;
    } catch (error) {
      await writeFile(join(output, 'build.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error;
    }
    attemptedRun = true;
    try {
      const result = await docker(['run', '--name', name, '--label', `ce.package-owner=${ownership}`, '--memory', '2g', '--cpus', '1',
        '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=400m', image]);
      await writeFile(join(output, 'runtime.log'), result.stdout + result.stderr);
      const evidence = JSON.parse(result.stdout.trim());
      assert.equal(evidence.status, 'pass');
      await writeFile(join(output, 'verification.json'), JSON.stringify({ ...evidence, image: LINUX_IMAGE,
        constraints: { memoryBytes: 2 * 1024 ** 3, cpus: 1, tmpBytes: 400 * 1024 ** 2, network: 'none', sourceMounted: false },
        deployed: false }, null, 2));
      console.log(`Linux package gate passed: ${output}`);
    } catch (error) {
      await writeFile(join(output, 'runtime.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error;
    }
  } finally {
    if (attemptedRun) {
      const inspected = await docker(['inspect', '--format', '{{index .Config.Labels "ce.package-owner"}}', name]).catch(() => null);
      if (inspected?.stdout.trim() === ownership) await docker(['rm', '--force', name]);
    }
    if (built) {
      const inspected = await docker(['image', 'inspect', '--format', '{{index .Config.Labels "ce.package-owner"}}', image]).catch(() => null);
      if (inspected?.stdout.trim() === ownership) await docker(['image', 'rm', image]);
    }
    const cleanupRelative = relative(join(root, '.cache'), resolve(context));
    if (cleanupRelative === `package-linux-${ownership}`) await rm(context, { recursive: true, force: true });
    console.log(`Package logs: ${output}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const action = process.argv.includes('--inside-build') ? insideBuild : outsideBuild;
  action().catch(error => { console.error(error instanceof Error ? error.message : 'Linux package gate failed.'); process.exitCode = 1; });
}
