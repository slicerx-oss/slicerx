// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

// SX_E2E_PORT serves the app on another port, for a second run on the same machine.
const port = Number(process.env['SX_E2E_PORT'] ?? 4317)
// A free loopback port, picked once here; workers load this file again and read it back from the environment.
const freePort = (): string =>
  execFileSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"]).toString()
// The hub port the test build pairs with when a page names none: SX_TEST_HUB_PORT, else a free one, so a page never
// reaches a running sx-link on 47615. Each bridge file runs its own hub on a port of its own and points its pages at it
// (e2e/bridge-hub.ts), so bridge files run in parallel and beside another run, the release gate or a running sx-link.
const hubPort = process.env['SX_TEST_HUB_PORT'] || freePort()
process.env['SX_TEST_HUB_PORT'] = hubPort
// The app slices in the native engine (e2e/native-host/server.mjs runs `sx` from SX_CLI_BIN, else this checkout's release
// build), on a free loopback port picked here and shared with the workers through the environment.
const sxBin = process.env['SX_CLI_BIN'] || resolve(import.meta.dirname, '../../target/release/sx')
if (!existsSync(sxBin)) throw new Error(`The browser suite slices with the native sx (${sxBin}); build it with cargo build --release -p sx-cli, or set SX_CLI_BIN`)
const nativePort = process.env['SX_E2E_NATIVE_PORT'] || freePort()
process.env['SX_E2E_NATIVE_PORT'] = nativePort
const nativeUrl = `http://127.0.0.1:${nativePort}`
// SX_E2E_GPU=1 runs the installed Chrome with hardware WebGL, on a machine with a GPU (the project's GPU runner).
const gpu = process.env['SX_E2E_GPU'] === '1'

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
    baseURL: `http://127.0.0.1:${port}/studio/`,
    // Software WebGL so the viewport runs on machines and CI runners without a GPU, unless SX_E2E_GPU asks for the GPU.
    // On the GPU, a graphics process that restarts (several browsers starting theirs at once) leaves Chrome blocking
    // WebGL for the page, or, after a few restarts, turning hardware graphics off for the browser: the app then opens
    // in its 2D view and the test fails until a retry gets a new browser. Neither block helps a test run.
    ...(gpu ? { channel: 'chrome' } : {}),
    launchOptions: {
      args: gpu
        ? ['--ignore-gpu-blocklist', '--disable-domain-blocking-for-3d-apis', '--disable-gpu-process-crash-limit']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  // Always build and serve a fresh bundle with the test environment. A server left running from an earlier build hides changes (and lacks the relay URL the phone pairing tests need).
  // The build leaves the WebAssembly slicer out (SLICERX_WEB_SLICING=0) and slices through the native test host.
  // The native host gets SIGTERM so it removes its temporary directory; without gracefulShutdown Playwright SIGKILLs it
  // and every run leaves a sx-e2e-native-* folder of meshes and G-code behind.
  webServer: [
    { command: `node e2e/native-host/server.mjs --port ${nativePort} --origin http://127.0.0.1:${port}`, url: `${nativeUrl}/healthz`, reuseExistingServer: false, timeout: 30_000, env: { SX_CLI_BIN: sxBin }, gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 } },
    { command: `pnpm exec vite build && pnpm exec vite preview --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}/studio/`, reuseExistingServer: false, timeout: 120_000, env: { SLICERX_E2E: '1', SLICERX_WEB_SLICING: '0', SLICERX_E2E_NATIVE_URL: nativeUrl, SX_TEST_HUB_PORT: hubPort, SLICERX_SUPABASE_URL: '', SLICERX_SUPABASE_ANON_KEY: '', SLICERX_RELAY_URL: 'https://relay.example.invalid' } },
  ],
})
