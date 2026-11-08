import { parentPort, workerData } from 'node:worker_threads';
// A real isolated worker used only for runner lifetime/fencing tests; domain calculation is covered separately.
const mode = workerData.claim.inputRefs.testMode;
if (mode === 'crash') throw new Error('Synthetic worker failure, never a public diagnostic.');
if (mode === 'result') parentPort.postMessage({ type: 'result', output: workerData.claim.inputRefs.testOutput });
if (mode === 'failure') parentPort.postMessage({ type: 'failure', diagnostic: { code: 'INVALID_DIRECTION', message: 'Synthetic policy failure.' } });
parentPort.postMessage({ type: 'progress', completed: 0, total: 1 });
// Remaining alive after result proves the runner awaits termination instead of treating a message as exit.
setInterval(() => {}, 1000);
