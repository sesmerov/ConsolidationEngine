import { EventEmitter } from 'node:events';
import type { SnapshotContent } from '@ce/contracts';
export function content(): SnapshotContent {
  return { catalogVersion: 'one', reportVersion: 'one', configVersion: 'one', profileId: 'ce-dpmxl-0.9-closed-v1',
    contexts: [], catalog: { records: [], variants: [], analyses: [], coverage: { rows: 0, variants: 0, applicableVariants: 0, supportedVariants: 0, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } },
    coordinates: [], facts: [{ factKey: 'fixture', contextId: 'demo', tableCode: 'C_01.00', sheetCode: '', rowCode: '0230', columnCode: '0010', presence: 'value', originalText: '10', normalizedValue: { numerator: '10', denominator: '1' }, sourceLocator: {} }], directions: [], sources: [] };
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
