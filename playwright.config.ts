import { defineConfig, devices } from '@playwright/test'

/**
 * Acceptance suite runs against a seeded local read gateway (no Cloudflare,
 * no credentials, no remote deployment). Browsers: Chromium, Firefox, WebKit.
 * WebKit is not Safari.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8790',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:8790/api/version',
    reuseExistingServer: false,
    timeout: 90_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
