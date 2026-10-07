// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// e2e/vault-flow.spec.ts against the stack from e2e/stack/vault-stack.sh. The app is built against that stack and
// served on the origin the stack allows for sign-in links. SX_E2E_CHANNEL=chrome runs the installed Chrome.
import { defineConfig } from '@playwright/test'

const channel = process.env['SX_E2E_CHANNEL']
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'vault-flow.spec.ts',
  timeout: 600_000,
  retries: 0,
  workers: 1,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:4393/studio/',
    ...(channel ? { channel } : {}),
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'pnpm exec vite build && pnpm exec vite preview --port 4393 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4393/studio/',
    reuseExistingServer: Boolean(process.env['SX_E2E_REUSE_SERVER']),
    timeout: 300_000,
    env: { SLICERX_E2E: '1', SLICERX_SUPABASE_URL: process.env['SX_E2E_SUPABASE_URL'] ?? '', SLICERX_SUPABASE_ANON_KEY: process.env['SX_E2E_ANON_KEY'] ?? '' },
  },
})
