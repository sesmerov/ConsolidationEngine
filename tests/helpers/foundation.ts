import { EventEmitter } from 'node:events';
import type { SnapshotContent } from '@ce/contracts';
export function content(): SnapshotContent {
  return { catalogVersion: 'one', reportVersion: 'one', configVersion: 'one', profileId: 'ce-dpmxl-0.9-closed-v1',
    contexts: [], catalog: { records: [] }, coordinates: [], facts: [{ value: '10' }], directions: [], sources: [] };
}
export class ControlledWorker extends EventEmitter {
  terminated = false;
  async terminate() { this.terminated = true; this.emit('exit', 0); return 0; }
  complete(value: object = {}) { this.emit('message', { type: 'result', output: { complete: true, ...value } }); }
}
export function controlledFactory() {
  const workers: ControlledWorker[] = [];
  return { workers, factory: () => { const worker = new ControlledWorker(); workers.push(worker); return worker; } };
}
export const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
