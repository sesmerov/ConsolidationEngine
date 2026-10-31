import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= path.resolve('.cache/playwright');
export default defineConfig({ testDir: '.', testMatch: 'validation-browser.spec.ts', fullyParallel: false, retries: 0, workers: 1,
  timeout: 240000, expect: { timeout: 65000 }, reporter: [['list']], outputDir: path.join(process.env['BENCH_OUTPUT']!, 'playwright'),
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3317', trace: 'off', video: 'off' } });
