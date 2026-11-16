import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/performance/hosted-capacity.spec.ts'], maxWorkers: 1, fileParallelism: false, testTimeout: 240_000, hookTimeout: 60_000 } });
