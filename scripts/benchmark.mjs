import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd();
const mode = '--' + (process.argv[2] ?? 'prepare').replace(/^--/, '');
const location = path.resolve(process.argv[3] ?? '.cache/benchmark/reference');

if (mode === '--server') {
  let phase = 'startup';
  const costs = {};
  if (process.env.BENCH_PILOT === '1') {
    const { WorkspaceStore } = await import('../apps/api/dist/session/workspace-store.js');
    for (const name of ['check', 'get', 'updateJob', 'publishJobResult']) {
      const original = WorkspaceStore.prototype[name];
      WorkspaceStore.prototype[name] = function (...args) {
        const start = performance.now();
        try { return original.apply(this, args); } finally {
          const key = phase + ':' + name, current = costs[key] ??= { calls: 0, milliseconds: 0, maximum: 0 };
          const elapsed = performance.now() - start; current.calls++; current.milliseconds += elapsed; current.maximum = Math.max(current.maximum, elapsed);
        }
      };
    }
  }
  const sample = () => process.send?.({ type: 'benchmark', phase, memory: process.memoryUsage(), costs });
  process.on('message', message => { if (message?.phase) { sample(); phase = message.phase; } });
  setInterval(sample, 250).unref();
  await import('../apps/api/dist/server.js');
} else if (mode === '--prepare') {
  await fs.mkdir(location, { recursive: true });
  const referencePath = path.join(location, 'reference.json');
  try { await fs.access(referencePath); throw new Error('Reference already frozen. Choose another directory.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve('.cache/playwright');
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true }); const chromiumVersion = browser.version(); await browser.close();
  const command = (exe, args) => { try { return execFileSync(exe, args, { encoding: 'utf8', windowsHide: true }).trim(); } catch { return 'unavailable'; } };
  const reference = { capturedBeforePilot: new Date().toISOString(), commit: command('git', ['rev-parse', 'HEAD']), dirty: command('git', ['status', '--short']),
    hardware: { cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, ramBytes: os.totalmem(), platform: os.platform(), architecture: os.arch(), osRelease: os.release(), osVersion: os.version(),
      windows: command('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory | ConvertTo-Json -Compress']), powerPlan: command('powercfg', ['/getactivescheme']) },
    runtime: { node: process.version, v8: process.versions.v8, chromium: chromiumVersion, headless: true, playwright: '1.64.1' },
    limits: { oldGenerationWorkerMiB: 256, sessionStateMiB: 512, jobMilliseconds: 60000, instances: 1000000, reads: 10000000, edges: 1000000 },
    protocol: { trials: 10, retries: 0, freshApiPerTrial: true, freshBrowserContextPerTrial: true, t0: 'Chromium response event for the first import job succeeded, before UI refresh and validation click', t1: 'completed run, 500 rows/variants/instances, zero duplicates, 50 DOM result rows, and two animation frames', audit: 'all 500 paginated results; 250 pass, 250 fail; 100000 distinct fact reads, 200 per result', criterion: 'at least 9 of 10 at most 30000 ms; any over 60000 ms must expose a diagnostic', loadExcluded: true } };
  // Freeze the machine and protocol before even generating the workload.
  await fs.writeFile(referencePath, JSON.stringify(reference, null, 2), { flag: 'wx' });
  const { writeIncrementalWorkbook } = await import('../apps/api/dist/export/bounded-files.js');
  const { EBA_HEADERS, CONTEXT_HEADERS, COORDINATE_HEADERS, FACT_HEADERS } = await import('@ce/contracts');
  const code = n => String(n).padStart(6, '0');
  const cents = n => BigInt((n * 37) % 10007 - 5003);
  const decimal = n => `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / 100n}.${String((n < 0n ? -n : n) % 100n).padStart(2, '0')}`;
  const rules = [];
  for (let rule = 0; rule < 500; rule++) {
    const first = rule * 200 + 1, last = first + 199; let sum = 0n;
    for (let row = first; row <= last; row++) sum += cents(row);
    const expected = sum + (rule % 2 ? 1n : 0n), literal = decimal(expected);
    rules.push({ code: 'SYNTHETIC_BENCH_' + code(rule + 1), first, last, status: rule % 2 ? 'fail' : 'pass', sum: decimal(sum), expression: `sum({tC_BENCH,r${code(first)}-${code(last)},c0010})=${expected < 0n ? '(' + literal + ')' : literal}` });
  }
  function* catalog() { yield EBA_HEADERS; for (const rule of rules) yield [rule.code, 'SYNTHETIC_BENCHMARK', 'COREP', 'COREP_OF_4.2', 'no', 'C_BENCH', rule.expression, '', 'Synthetic sum of 200 distinct reported facts', 'Active', '2025-01-01', '', 'error', '', 'no']; }
  function* coordinates() { yield COORDINATE_HEADERS; for (let row = 1; row <= 100000; row++) yield ['bench', 'C_BENCH', '', code(row), '0010', 'number', 'EUR', '2', '{}']; }
  function* facts() { yield FACT_HEADERS; for (let row = 1; row <= 100000; row++) yield ['bench', 'C_BENCH', '', code(row), '0010', 'value', decimal(cents(row))]; }
  const budget = { expandedBytes: 0 }, maximum = 10 * 1024 * 1024, maxExpanded = 100 * 1024 * 1024;
  await fs.writeFile(path.join(location, 'catalog.xlsx'), '', { flag: 'wx' }); await fs.writeFile(path.join(location, 'report.xlsx'), '', { flag: 'wx' });
  const catalogFile = await writeIncrementalWorkbook(path.join(location, 'catalog.xlsx'), [{ name: 'Validation rules', rows: catalog() }], maximum, budget, maxExpanded, () => {});
  const reportFile = await writeIncrementalWorkbook(path.join(location, 'report.xlsx'), [{ name: 'Instructions', rows: [['SYNTHETIC_BENCHMARK ce-report-1']] },
    { name: 'Contexts', rows: [CONTEXT_HEADERS, ['ce-report-1', 'bench', 'SYNTHETIC_ENTITY', '2025-06-30', '2025-07-01', 'COREP', 'COREP_OF_4.2', '{}']] }, { name: 'Coordinates', rows: coordinates() }, { name: 'Facts', rows: facts() }], maximum, budget, maxExpanded, () => {});
  const { parseRule } = await import('@ce/engine');
  for (const rule of rules) { const parsed = parseRule(rule.expression); if (parsed.syntaxStatus !== 'valid' || parsed.supportStatus !== 'supported') throw new Error('Unsupported benchmark expression: ' + rule.expression); }
  await fs.writeFile(path.join(location, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), facts: 100000, coordinates: 100000, rules, catalogFile, reportFile }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ location, reference, catalogFile, reportFile }, null, 2));
} else if (mode === '--pilot' || mode === '--cohort') {
  await fs.access(path.join(location, 'reference.json')); await fs.access(path.join(location, 'manifest.json'));
  const manifest = JSON.parse(await fs.readFile(path.join(location, 'manifest.json'), 'utf8'));
  for (const [name, expected] of [['catalog.xlsx', manifest.catalogFile], ['report.xlsx', manifest.reportFile]]) {
    const buffer = await fs.readFile(path.join(location, name));
    if (buffer.length !== expected.size || createHash('sha256').update(buffer).digest('hex') !== expected.sha256) throw new Error('Frozen workload changed: ' + name);
  }
  const label = (mode === '--pilot' ? 'pilot-' : 'cohort-') + new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(location, label); await fs.mkdir(output);
  const changed = [...new Set((execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }) + execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })).trim().split(/\r?\n/).filter(Boolean))];
  const files = {}; for (const name of changed) { try { files[name] = createHash('sha256').update(await fs.readFile(name)).digest('hex'); } catch { files[name] = 'deleted'; } }
  await fs.writeFile(path.join(output, 'code.json'), JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files, diff: execFileSync('git', ['diff'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }), startedAt: new Date().toISOString(), tracing: false, video: false }, null, 2));
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '-c', 'tests/performance/playwright.config.ts'], { cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.resolve('.cache/playwright'), BENCH_DIR: location, BENCH_OUTPUT: output, BENCH_PILOT: mode === '--pilot' ? '1' : '0' } });
  process.exitCode = await new Promise(resolve => child.on('exit', code => resolve(code ?? 1)));
  const rows = []; for (const name of await fs.readdir(output)) if (/^trial-\d+\.json$/.test(name)) rows.push(JSON.parse(await fs.readFile(path.join(output, name), 'utf8')));
  rows.sort((a, b) => a.trial - b.trial); const valid = rows.filter(row => row.auditPassed && row.elapsedMs <= 30000);
  const summary = { mode, rows, atMost30Seconds: valid.length, expectedTrials: mode === '--pilot' ? 1 : 10, passed: mode === '--cohort' && rows.length === 10 && valid.length >= 9 && rows.every(row => row.elapsedMs <= 60000 || row.diagnosticVisible) };
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify({ output, atMost30Seconds: valid.length, passed: summary.passed }));
  if (mode === '--cohort' && !summary.passed) process.exitCode = 1;
} else throw new Error('Use --prepare, --pilot or --cohort followed by an output directory.');
