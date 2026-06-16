import { defineConfig } from '@playwright/test';

/**
 * Full-stack E2E: boots the real API (live Upbit/Hyperliquid universe, live
 * feeds, liquidity bot, fresh PGlite dir) and the Vite dev server, then drives
 * the real UI in Chromium. Requires internet (all market data is real).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1, // one trading session at a time — tests share the exchange state
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5180',
    viewport: { width: 1600, height: 900 },
    locale: 'ko-KR',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'sh -c "rm -rf .dex-e2e-data && DEX_DATA_DIR=.dex-e2e-data pnpm --filter @dex/api dev"',
      cwd: '..',
      url: 'http://127.0.0.1:3001/api/health',
      timeout: 180_000,
      reuseExistingServer: true,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @dex/web dev',
      cwd: '..',
      url: 'http://localhost:5180',
      timeout: 60_000,
      reuseExistingServer: true,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
