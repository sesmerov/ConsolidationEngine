import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HostedWorkerRequest } from '../../apps/api/src/workers/protocol.js';
import type { HostedCommandDependencies } from '../../apps/api/src/hosted/worker-runtime.js';

/** Test instrumentation only. Fixed compiled production command, unchanged limits and no business payloads in evidence. */
export async function executeHostedCommand(request: HostedWorkerRequest, cancelled: () => boolean) {
  const commands = await import(pathToFileURL(path.resolve('apps/api/dist/hosted/domain-commands.js')).href);
  if (!['validate', 'export'].includes(request.claim.kind)) return commands.executeHostedCommand(request, cancelled);
  const { createHostedWorkerRuntime } = await import(pathToFileURL(path.resolve('apps/api/dist/hosted/worker-runtime.js')).href);
  const deps = await createHostedWorkerRuntime(request) as HostedCommandDependencies & { close(): Promise<void> };
  const phases: { phase: string; startedMs: number; durationMs?: number; canonicalWrites?: number }[] = [];
  const start = Date.parse(request.claim.startedAt); let active: typeof phases[number] | undefined, canonicalWrites = 0;
  const save = async () => writeFile(path.join(process.env['CAPACITY_EVIDENCE']!, `phases-${request.claim.jobId}.json`), JSON.stringify({ jobId: request.claim.jobId, recordedMs: Date.now() - start, phases }, null, 2));
  const begin = async (phase: string) => { if (active && active.durationMs === undefined) active.durationMs = Date.now() - start - active.startedMs; active = { phase, startedMs: Date.now() - start }; phases.push(active); await save(); };
  const hydrate = deps.repository.loadSnapshot.bind(deps.repository);
  deps.repository.loadSnapshot = async (...args) => { await begin('hydrate'); const result = await hydrate(...args); await begin(request.claim.kind === 'export' ? 'prepare-and-write-export' : 'evaluate'); return result; };
  const put = deps.codec.put.bind(deps.codec);
  deps.codec.put = async (...args) => { await begin('canonical-validation-bundle'); const result = await put(...args); await begin('between-projections'); return result; };
  const stage = deps.indexes.stage.bind(deps.indexes);
  deps.indexes.stage = async (...args) => { await begin('projection:' + args[1].resource.view); const result = await stage(...args); await begin('between-projections'); return result; };
  const object = deps.objects.putCanonical.bind(deps.objects);
  deps.objects.putCanonical = async (...args) => { const result = await object(...args); canonicalWrites++; if (active) active.canonicalWrites = (active.canonicalWrites ?? 0) + 1; if (canonicalWrites % 25 === 0) await save(); return result; };
  try { await begin('initialize'); const result = request.claim.kind === 'export'
    ? await (await import(pathToFileURL(path.resolve('apps/api/dist/hosted/transfer-commands.js')).href)).executeTransferCommand(request, cancelled, deps)
    : await commands.executeRegulatoryCommand(request, cancelled, deps); await begin('worker-output'); return result; }
  finally { if (active && active.durationMs === undefined) active.durationMs = Date.now() - start - active.startedMs; await save(); await deps.close(); }
}
