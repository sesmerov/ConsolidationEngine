import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'engine', environment: 'node', include: ['packages/engine/test/**/*.spec.ts'] } },
      { test: { name: 'integration', environment: 'node', include: ['tests/integration/**/*.spec.ts'], exclude: ['tests/integration/hosted-*.spec.ts'], testTimeout: 30_000 } },
      { test: { name: 'contract', environment: 'node', include: ['tests/contract/**/*.spec.ts'], exclude: ['tests/contract/hosted-*.spec.ts'], testTimeout: 30_000 } },
      { test: { name: 'hosted', environment: 'node', include: ['tests/hosted/**/*.spec.ts', 'tests/integration/hosted-*.spec.ts', 'tests/contract/hosted-*.spec.ts'], testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 1 } },
    ],
  },
});
