import { parentPort, workerData } from 'node:worker_threads';
import type { HostedCommandModule, HostedWorkerMessage, HostedWorkerRequest } from './protocol.js';
import { receivedDiagnostic } from '../public-diagnostic.js';
import { ApiError } from '../errors.js';

const request = workerData as HostedWorkerRequest;
const signal = new Int32Array(request.cancellation);
const cancelled = () => Atomics.load(signal, 0) !== 0 || Date.now() >= Date.parse(request.claim.deadlineAt);
const send = (message: HostedWorkerMessage) => parentPort?.postMessage(message);
try {
  if (!request.commandModule || new URL(request.commandModule).protocol !== 'file:' || cancelled()) throw new ApiError('INTERNAL_ERROR');
  // This path comes only from server composition. No request body, database row or visitor can choose executable code.
  const module = await import(request.commandModule) as HostedCommandModule;
  const output = await module.executeHostedCommand(request, cancelled);
  if (cancelled()) throw new ApiError('INTERNAL_ERROR');
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 262_144) throw new ApiError('INTERNAL_ERROR');
  send({ type: 'result', output });
} catch (error) { send({ type: 'failure', diagnostic: receivedDiagnostic({ code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR' }) }); }
finally { parentPort?.close(); }
