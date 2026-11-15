import { parentPort, workerData } from 'node:worker_threads';
import type { HostedCommandModule, HostedWorkerMessage, HostedWorkerRequest } from './protocol.js';
import { ApiError } from '../errors.js';
import { assertHostedCommandActive, hostedCommandDiagnostic } from '../hosted/command-diagnostics.js';

const request = workerData as HostedWorkerRequest;
const signal = new Int32Array(request.cancellation);
const cancelled = () => Atomics.load(signal, 0) !== 0 || Date.now() >= Date.parse(request.claim.deadlineAt);
const send = (message: HostedWorkerMessage) => parentPort?.postMessage(message);
try {
  assertHostedCommandActive(request.claim.deadlineAt, Atomics.load(signal, 0) !== 0);
  if (!request.commandModule || new URL(request.commandModule).protocol !== 'file:') throw new ApiError('INTERNAL_ERROR');
  // This path comes only from server composition. No request body, database row or visitor can choose executable code.
  const module = await import(request.commandModule) as HostedCommandModule;
  const output = await module.executeHostedCommand(request, cancelled);
  assertHostedCommandActive(request.claim.deadlineAt, Atomics.load(signal, 0) !== 0);
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 262_144) throw new ApiError('INTERNAL_ERROR');
  send({ type: 'result', output });
} catch (error) {
  let failure = error;
  try { assertHostedCommandActive(request.claim.deadlineAt, Atomics.load(signal, 0) !== 0); } catch (authorityError) { failure = authorityError; }
  send({ type: 'failure', diagnostic: hostedCommandDiagnostic(failure) });
}
finally { parentPort?.close(); }
