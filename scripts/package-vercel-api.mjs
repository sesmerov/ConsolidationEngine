import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPackageToolchain, executePackageNpm } from './lib/package-build.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const API_RUNTIME_FILES = Object.freeze([
  'apps/api/dist/hosted-entry.js', 'apps/api/dist/app.js',
  ...['operation-worker', 'hosted-operation-worker', 'seal-upload.worker', 'local-seal-upload.worker', 'import.worker', 'inspect-import.worker', 'validate.worker', 'preview.worker',
    'prepare-directions.worker', 'commit-directions.worker', 'select-proposals.worker',
    'recalculation-operation.worker', 'apply.worker', 'export.worker'].map(name => `apps/api/dist/workers/${name}.js`),
  'apps/api/dist/hosted/domain-commands.js', 'apps/api/dist/hosted/transfer-commands.js',
  ...['001-demo', '002-object-claims', '003-authority-records', '004-upload-transfers', '005-projection-values',
    '006-mutation-receipts', '007-export-reservations', '008-review-choices'].map(name => `apps/api/dist/hosted/migrations/${name}.sql`),
  ...['corep-ca1', 'demo-types', 'finrep-f0101'].map(name => `apps/api/dist/import/profiles/${name}-mapping.json`),
  ...['corep-ca1.xlsx', 'demo-types.xlsx', 'finrep-f0101.xlsx', 'manifest.json'].map(name => `apps/api/dist/assets/templates/${name}`),
  ...['corep', 'types', 'finrep'].flatMap(name => ['catalog', 'report'].map(kind => `apps/api/dist/assets/demos/demo-${name}-${kind}.xlsx`)),
  'apps/api/dist/assets/demos/manifest.json', 'packages/contracts/dist/index.js', 'packages/engine/dist/index.js',
  ...['dpm_xlLexer.js', 'dpm_xlParser.js', 'dpm_xlParserVisitor.js'].map(name => `packages/engine/dist/generated/${name}`),
]);

async function hashTree(root, directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error(`Invalid runtime tree: ${relative(root, directory)}`);
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const location = join(directory, item.name);
    if (item.isDirectory()) files.push(...await hashTree(root, location));
    else if (item.isFile()) {
      const bytes = await readFile(location);
      files.push({ path: relative(root, location).replaceAll('\\', '/'), bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error(`Runtime files cannot be symbolic links: ${relative(root, location)}`);
  }
  return files;
}

export async function packageApi({ root = projectRoot, environment = process.env, runNpm = executePackageNpm } = {}) {
  const options = { root: resolve(root), environment };
  try { await access(join(options.root, 'apps/api/api/index.ts')); await access(join(options.root, 'apps/api/src/hosted-entry.ts')); }
  catch { throw new Error('The explicit hosted entry is missing (apps/api/api/index.ts and apps/api/src/hosted-entry.ts). Complete T087 before packaging.'); }
  await assertPackageToolchain(runNpm, options);
  await runNpm(['run', 'generate:parser'], options);
  await runNpm(['run', 'build:api'], options);
  for (const name of API_RUNTIME_FILES) {
    try { if (!(await lstat(join(options.root, name))).isFile()) throw new Error(); }
    catch { throw new Error(`Required runtime file missing: ${name}`); }
  }
  const files = [];
  for (const name of ['apps/api/dist', 'packages/contracts/dist', 'packages/engine/dist']) files.push(...await hashTree(options.root, join(options.root, name)));
  for (const name of ['apps/api/api/index.ts', 'packages/contracts/package.json', 'packages/engine/package.json']) {
    const bytes = await readFile(join(options.root, name));
    files.push({ path: name, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifestPath = join(options.root, 'apps/api/.vercel-dist/runtime-manifest.json');
  await mkdir(join(options.root, 'apps/api/.vercel-dist'), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, node: process.version, files: files.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
  return { manifestPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  packageApi().then(({ manifestPath }) => console.log(`API runtime files verified: ${manifestPath}`)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'API packaging failed.'); process.exitCode = 1;
  });
}
