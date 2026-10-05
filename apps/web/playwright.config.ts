// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  // A cold start can take well over a minute on a machine busy with software graphics, and the specs wait for the app's
  // own ready mark (e2e/fixtures.ts) instead of a fixed time, so a test gets room for it.
  timeout: 120_000,
  retries: 0,
  // Each page starts a pool of one slicer worker per core and draws with software WebGL. Five pages booting at once
  // (the default here) starve each other: a cold start goes from 3 s alone to 14 s, past the 15 s wait, and the first
  // tests of a run fail. Three at a time stays clear (three full runs in a row) and is no slower overall.
  workers: 3,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:4317/studio/',
    // Software WebGL so the viewport runs on machines and CI runners without a GPU.
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  // Always build and serve a fresh bundle with the test environment. A server left running from an earlier build hides changes (and lacks the relay URL the phone pairing tests need).
  webServer: { command: 'pnpm exec vite build && pnpm exec vite preview --port 4317 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:4317/studio/', reuseExistingServer: false, timeout: 120_000, env: { SLICERX_E2E: '1', SLICERX_SUPABASE_URL: '', SLICERX_SUPABASE_ANON_KEY: '', SLICERX_RELAY_URL: 'https://relay.example.invalid' } },
})
