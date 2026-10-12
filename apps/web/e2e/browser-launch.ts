// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The worker's browser, launched again when Chrome on Windows refuses to start with "Failed to create a
// ProcessSingleton for your profile directory" (exit code 21). Each launch gets a fresh profile folder of its own, so
// this is not a shared profile: it has shown up on a GPU runner while another runner had six Chromes of its own up.
// A retry starts a browser that works. Each one is logged, so the runs can be counted.
import { hostname } from 'node:os'
import { test as base, type Browser, type PlaywrightWorkerArgs, type PlaywrightWorkerOptions } from '@playwright/test'

const SINGLETON = /ProcessSingleton|exitCode=21\b/
const WAITS_MS = [1000, 3000]

/** Runs `launch`, and again after each of WAITS_MS when it fails with the ProcessSingleton error. */
export async function launchWithRetry(launch: () => Promise<Browser>, log: (line: string) => void = console.log): Promise<Browser> {
  const runner = process.env['RUNNER_NAME'] || hostname()
  for (let attempt = 0; ; attempt++) {
    try {
      return await launch()
    } catch (e) {
      const wait = WAITS_MS[attempt]
      if (wait === undefined || !SINGLETON.test(String(e instanceof Error ? e.message : e))) throw e
      log(`browser launch retried: ProcessSingleton, runner ${runner}, retry ${attempt + 1} of ${WAITS_MS.length}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

type BrowserArgs = PlaywrightWorkerArgs & PlaywrightWorkerOptions & { _browserOptions?: unknown }

export const test = base.extend<object, { browser: Browser }>({
  // Playwright's own browser fixture, with the launch retried. Asking for _browserOptions sets the launch options
  // from the config (channel, args, trace folders) as the default for the bare launch() below, as it does there.
  browser: [
    async ({ playwright, browserName, _browserOptions }: BrowserArgs, use) => {
      void _browserOptions
      const browser = await launchWithRetry(() => playwright[browserName].launch())
      await use(browser)
      await browser.close({ reason: 'Test ended.' })
    },
    { scope: 'worker', timeout: 0 },
  ],
})
