import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= path.resolve('.cache/playwright');
if (!process.env['CE_E2E_CONTROL_TOKEN']) throw new Error('Use npm run test:e2e:hosted; this suite requires its owned two-instance harness.');
export default defineConfig({
  testDir: '.', testMatch: 'hosted-journey.spec.ts', fullyParallel: false, forbidOnly: Boolean(process.env['CI']), retries: 0, workers: 1,
  timeout: 240_000, expect: { timeout: 20_000 }, outputDir: '../../test-results/hosted',
  reporter: [['list'], ['json', { outputFile: path.resolve('test-results/hosted-results.json') }],
    ['html', { outputFolder: '../../playwright-report/hosted', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3350', actionTimeout: 20_000, navigationTimeout: 20_000, trace: 'retain-on-failure' }, projects: [{ name: 'hosted-chromium', use: { ...devices['Desktop Chrome'] } }],
});
