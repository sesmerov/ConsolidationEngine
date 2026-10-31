import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'engine', environment: 'node', include: ['packages/engine/test/**/*.spec.ts'] } },
      { test: { name: 'integration', environment: 'node', include: ['tests/integration/**/*.spec.ts'], testTimeout: 30_000 } },
      { test: { name: 'contract', environment: 'node', include: ['tests/contract/**/*.spec.ts'] } },
    ],
  },
});
