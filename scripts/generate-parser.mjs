import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(new URL('./antlr-toolchain.json', import.meta.url), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const outputFlag = process.argv.indexOf('--output');
const outputDirectory = outputFlag === -1
  ? path.join(root, 'packages/engine/src/generated')
  : path.resolve(process.argv[outputFlag + 1] ?? '');
const relativeOutput = path.relative(root, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
  throw new Error('ANTLR output must remain inside this project.');
}
const inputDirectory = path.join(root, '.cache/antlr-input');
const jarPath = path.join(root, '.tools', 'antlr-' + config.version + '-complete.jar');
await mkdir(path.dirname(jarPath), { recursive: true });
let jarBytes;
try { jarBytes = await readFile(jarPath); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(config.url);
  if (!response.ok) throw new Error('ANTLR download failed: HTTP ' + response.status);
  jarBytes = Buffer.from(await response.arrayBuffer());
  if (sha256(jarBytes) !== config.sha256) throw new Error('ANTLR download checksum mismatch.');
  const temporaryPath = jarPath + '.download';
  await writeFile(temporaryPath, jarBytes);
  await rename(temporaryPath, jarPath);
}
if (sha256(jarBytes) !== config.sha256) throw new Error('ANTLR jar checksum mismatch; generation refused.');
const runtime = JSON.parse(await readFile(path.join(root, 'node_modules/antlr4/package.json'), 'utf8'));
if (runtime.version !== config.runtimeVersion) throw new Error('ANTLR tool/runtime versions differ.');

await mkdir(inputDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
for (const [name, expectedHash] of Object.entries(config.grammars)) {
  const bytes = await readFile(path.join(root, 'grammar', name));
  if (sha256(bytes) !== expectedHash) throw new Error('Original grammar hash mismatch: ' + name);
  await writeFile(path.join(inputDirectory, name.replace('-v0.9', '')), bytes);
}
const javaVersionResult = spawnSync('java', ['-version'], { encoding: 'utf8', windowsHide: true });
if (javaVersionResult.error) throw javaVersionResult.error;
if (javaVersionResult.status !== 0) throw new Error(javaVersionResult.stderr || 'Java is unavailable.');
const javaVersion = (javaVersionResult.stderr + javaVersionResult.stdout).trim();
const major = Number(javaVersion.match(/version "(\d+)/)?.[1]);
if (!Number.isInteger(major) || major < 11) throw new Error('ANTLR requires Java 11 or newer.');
for (const grammar of ['dpm_xlLexer.g4', 'dpm_xlParser.g4']) {
  const result = spawnSync('java', [
    '-jar', jarPath, '-Dlanguage=JavaScript', '-visitor', '-no-listener',
    '-encoding', 'UTF-8', '-Xexact-output-dir', '-o', outputDirectory,
    '-lib', outputDirectory, grammar,
  ], { cwd: inputDirectory, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'ANTLR generation failed.');
  if (result.stderr.trim()) process.stderr.write(result.stderr);
}
await writeFile(path.join(outputDirectory, 'generation-manifest.json'), JSON.stringify({
  toolVersion: config.version,
  runtimeVersion: runtime.version,
  jarSha256: config.sha256,
  grammars: config.grammars,
  javaVersion,
}, null, 2) + '\n');
process.stdout.write('ANTLR ' + config.version + ': lexer, parser and visitor generated; source hashes unchanged.\n');
