import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GENERATED_PARSER_FILES, LINUX_IMAGE, allowedBuildInput, compareGeneratedParser, packageDockerfile } from '../../scripts/test-package-linux.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('isolated Linux package gate', () => {
  it('pins the tested Linux image and keeps source checkout out of the runtime stage', () => {
    expect(LINUX_IMAGE).toBe('node@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9');
    const dockerfile = packageDockerfile();
    expect(dockerfile).toContain('openjdk-17-jre-headless');
    expect(dockerfile).toContain('npm run test:package:linux -- --inside-build');
    expect(dockerfile).toContain('COPY --from=build /build/.cache/linux-runtime/ /app/');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    expect(runtime).not.toContain('COPY project');
    expect(runtime).not.toContain('COPY --from=build /build/ /app/');
    expect(runtime).toContain('USER node');
  });

  it.each([
    ['apps/api/src/app.ts', true], ['packages/engine/src/index.ts', true], ['grammar/dpm_xlParser-v0.9.g4', true],
    ['apps/api/.env', false], ['apps/api/.env.production', false], ['.env', false],
    ['apps/api/node_modules/private/index.js', false], ['node_modules/private.js', false],
    ['apps/api/dist/secret.json', false], ['apps/web/.vercel/project.json', false],
    ['.git/config', false], ['.agents/auth.json', false], ['.tools/node/node.exe', false],
    ['data/reports/real.xlsx', false], ['README.md', false],
  ])('filters build input %s', (path, included) => expect(allowedBuildInput(path)).toBe(included));

  it('compares all eight parser files byte for byte, including the generation manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ce-parser-package-')); roots.push(root);
    const first = join(root, 'first'), second = join(root, 'second');
    for (const directory of [first, second]) {
      await mkdir(directory);
      for (const name of GENERATED_PARSER_FILES) await writeFile(join(directory, name), `reproducible ${name}`);
    }
    expect((await compareGeneratedParser(first, second)).length).toBe(8);
    await writeFile(join(second, 'dpm_xlParser.js'), 'changed');
    await expect(compareGeneratedParser(first, second)).rejects.toThrow('dpm_xlParser.js');
    await writeFile(join(second, 'dpm_xlParser.js'), await readFile(join(first, 'dpm_xlParser.js')));
    await writeFile(join(second, 'unexpected.js'), 'unexpected');
    await expect(compareGeneratedParser(first, second)).rejects.toThrow('eight');
    expect(await readdir(root)).toHaveLength(2);
  });
});
