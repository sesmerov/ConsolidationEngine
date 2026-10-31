import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import antlr4 from 'antlr4';

const root = process.cwd();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sources = ['dpm_xlLexer-v0.9.g4', 'dpm_xlParser-v0.9.g4'];

async function sourceHashes() {
  return Promise.all(sources.map(async (name) => hash(await readFile(path.join(root, 'grammar', name)))));
}
function generate(output: string) {
  const result = spawnSync(process.execPath, ['scripts/generate-parser.mjs', '--output', output], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}
async function generatedHashes(output: string) {
  const files = (await readdir(output)).sort();
  return Promise.all(files.map(async (name) => [name, hash(await readFile(path.join(output, name)))]));
}
describe('the pinned ANTLR generation pipeline', () => {
  it('is repeatable, preserves original bytes, and consumes real syntax through EOF', async () => {
    const original = await sourceHashes();
    const cacheRoot = path.join(root, '.cache');
    await mkdir(cacheRoot, { recursive: true });
    const temporaryRoot = await mkdtemp(path.join(cacheRoot, 'antlr-generation-'));
    try {
      const first = path.join(temporaryRoot, 'first');
      const second = path.join(temporaryRoot, 'second');
      generate(first);
      generate(second);
      expect(await generatedHashes(first)).toEqual(await generatedHashes(second));
      expect(await sourceHashes()).toEqual(original);
      const { default: Lexer } = await import(/* @vite-ignore */ pathToFileURL(path.join(first, 'dpm_xlLexer.js')).href);
      const { default: Parser } = await import(/* @vite-ignore */ pathToFileURL(path.join(first, 'dpm_xlParser.js')).href);
      function parse(source: string) {
        const diagnostics: string[] = [];
        const listener = {
          syntaxError: (_recognizer: unknown, _symbol: unknown, _line: number, _column: number, message: string) => diagnostics.push(message),
          reportAmbiguity() {},
          reportAttemptingFullContext() {},
          reportContextSensitivity() {},
        };
        const lexer = new Lexer(new antlr4.InputStream(source));
        lexer.removeErrorListeners();
        lexer.addErrorListener(listener);
        const tokens = new antlr4.CommonTokenStream(lexer);
        const parser = new Parser(tokens);
        parser.removeErrorListeners();
        parser.addErrorListener(listener);
        parser.buildParseTrees = true;
        const tree = parser.start();
        return { diagnostics, tree, currentTokenType: parser.getCurrentToken().type };
      }
      const realRule = parse('with {default: 0, interval: true}: {tC_01.00, r0230, c0010} = {tC_05.01, r0090, c0060}');
      expect(realRule.diagnostics).toEqual([]);
      expect(realRule.tree).toBeDefined();
      expect(realRule.currentTokenType).toBe(antlr4.Token.EOF);
      expect(parse('with {default: null}: isnull({tC_01.00, r0230, c0010})').diagnostics).toEqual([]);
      expect(parse('null = null').diagnostics.length).toBeGreaterThan(0);
      expect(parse('1 = 1 @').diagnostics.length).toBeGreaterThan(0);
      expect(parse('1 = 1 2 = 2').diagnostics.length).toBeGreaterThan(0);
    } finally {
      const resolved = path.resolve(temporaryRoot);
      const relative = path.relative(path.resolve(cacheRoot), resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path.');
      await rm(resolved, { recursive: true, force: true });
    }
  });
});
