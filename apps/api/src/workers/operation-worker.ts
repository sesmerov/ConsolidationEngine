import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerOperation, WorkerRequest } from './protocol.js';
import { publicDiagnostic } from '../public-diagnostic.js';
const request = workerData as WorkerRequest;
const port = parentPort;
if (!port) throw new Error('Worker entry requires a parent port.');
const cancellation = new Int32Array(request.cancellation);
try {
  if (!request.moduleUrl) throw new Error('No operation module registered.');
  const operation = await import(request.moduleUrl) as WorkerOperation;
  const output = await operation.execute(request.input, { job: request.job,
    ...(request.snapshot ? { snapshot: request.snapshot } : {}), cancelled: () => Atomics.load(cancellation, 0) !== 0,
    progress: (completed, total) => port.postMessage({ type: 'progress', completed, total }),
  });
  if (Atomics.load(cancellation, 0) === 0) port.postMessage({ type: 'result', output });
} catch (error) {
  port.postMessage({ type: 'failure', diagnostic: publicDiagnostic(error) });
} finally { port.close(); }
