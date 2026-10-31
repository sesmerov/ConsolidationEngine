import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= path.resolve('.cache/playwright');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node apps/api/dist/server.js',
    env: { NODE_ENV: 'production', PORT: '3000' },
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
