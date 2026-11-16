import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPackageToolchain, executePackageNpm } from './lib/package-build.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const configId = 'ce-public-config';

/** This is deliberately an allowlist: no provider credential belongs in a browser build. */
export function readPublicConfig(environment) {
  const deploymentProfile = environment.DEPLOYMENT_PROFILE?.trim() || 'local';
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(deploymentProfile)) throw new Error('Invalid DEPLOYMENT_PROFILE.');
  const rawOrigin = environment.API_BASE_URL?.trim() || '';
  if (!rawOrigin) {
    if (deploymentProfile !== 'local') throw new Error('API_BASE_URL is required outside the local profile.');
    return { apiBaseUrl: '', deploymentProfile };
  }
  // Inspect the original spelling too: URL normalizes paths such as /../ away.
  if (!/^https?:\/\/[^/?#\\\s@]+\/?$/.test(rawOrigin)) throw new Error('API_BASE_URL must be an origin without a path, query or fragment.');
  let url;
  try { url = new URL(rawOrigin); } catch { throw new Error('Invalid API_BASE_URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hostname.includes('*') || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(deploymentProfile === 'local' && loopback))) {
    throw new Error('API_BASE_URL requires HTTPS; HTTP is allowed only for local loopback.');
  }
  return { apiBaseUrl: url.origin, deploymentProfile };
}

export function injectPublicConfig(html, config) {
  if (html.includes(configId)) throw new Error(`The build already contains ${configId}.`);
  if (!html.includes('</head>')) throw new Error('Angular output has no closing head element.');
  const publicConfig = readPublicConfig({ API_BASE_URL: config.apiBaseUrl, DEPLOYMENT_PROFILE: config.deploymentProfile });
  const json = JSON.stringify(publicConfig).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return html.replace('</head>', `<script id="${configId}" type="application/json">${json}</script></head>`);
}

async function assertRegularTree(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Expected a regular build output directory.');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await assertRegularTree(join(directory, entry.name));
    else if (!entry.isFile()) throw new Error('Build output must not contain links or special files.');
  }
}

export async function packageWeb({ root = projectRoot, environment = process.env, runNpm = executePackageNpm } = {}) {
  const publicConfig = readPublicConfig(environment);
  const options = { root: resolve(root), environment };
  await assertPackageToolchain(runNpm, options);
  await runNpm(['run', 'build', '--workspace', '@ce/contracts'], options);
  await runNpm(['run', 'build', '--workspace', '@ce/web', '--', '--configuration=production,vercel'], options);

  // Vercel and the local E2E server have distinct build trees.
  const source = join(options.root, 'dist/vercel-web/browser');
  const packageDirectory = join(options.root, 'apps/web/.vercel-dist');
  const outputDirectory = join(packageDirectory, 'browser');
  const stagingDirectory = join(packageDirectory, `browser-${process.pid}.staging`);
  await assertRegularTree(source);
  const index = injectPublicConfig(await readFile(join(source, 'index.html'), 'utf8'), publicConfig);
  await mkdir(packageDirectory, { recursive: true });
  if (!(await lstat(packageDirectory)).isDirectory()) throw new Error('The package output must not be a symbolic link.');
  try {
    // These paths are fixed children of this package, never user-provided cleanup targets.
    await rm(stagingDirectory, { recursive: true, force: true });
    await cp(source, stagingDirectory, { recursive: true });
    await writeFile(join(stagingDirectory, 'index.html'), index, 'utf8');
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, outputDirectory);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  return { outputDirectory, publicConfig };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  packageWeb().then(({ outputDirectory }) => console.log(`Static web package: ${outputDirectory}`)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Web packaging failed.');
    process.exitCode = 1;
  });
}
