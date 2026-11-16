import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= path.resolve('.cache/playwright');
// A test-owned process must never replace or reuse the analyst's port 3000.
const testPort = '3318';
const testOrigin = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: 'hosted-*.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  workers: 1,
  use: { baseURL: testOrigin, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node apps/api/dist/server.js',
    env: { NODE_ENV: 'production', PORT: testPort },
    url: testOrigin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
