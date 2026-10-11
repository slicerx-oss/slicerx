// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part of the app that loads slowly says so: the space it will fill shows a sheen and, after a moment, the word
// Loading, in both themes, instead of reading as an empty page.
import { type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

type Sx = { setState(p: unknown): void }

/** Holds back every script the page asks for from now on, until `release` is called. */
async function holdScripts(page: Page): Promise<() => void> {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  await page.route(/\/static\/[^/]+\.js$/, async (route) => {
    await gate
    await route.continue()
  })
  return release
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
}

test('a workspace that loads slowly shows Loading, then its page', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The top bar tabs are a desktop control')
  await open(page)
  const release = await holdScripts(page)
  await page.getByTestId('tab-printers').click()
  const loading = page.getByRole('status').filter({ hasText: 'Loading' })
  await expect(loading).toBeVisible()
  // The word waits a moment, so a quick load never flashes it, then reads clearly.
  await expect.poll(() => loading.locator('span').evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)
  release()
  await expect(loading).toHaveCount(0)
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: a slow workspace load, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'] || isMobile, 'SX_SHOTS=1, desktop')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  for (const width of [1440, 1100]) {
    for (const scheme of ['light', 'dark'] as const) {
      // A page of its own each time, so the workspace's scripts are not loaded yet.
      const p = await page.context().newPage()
      await p.setViewportSize({ width, height: 860 })
      await open(p)
      await p.evaluate((s) => (window as unknown as { __sx: Sx }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
      const release = await holdScripts(p)
      await p.getByTestId('tab-printers').click()
      await p.waitForTimeout(900)
      await p.mouse.move(0, 0)
      await p.screenshot({ path: `${dir}/loading-${scheme}-${width}.png` })
      release()
      await p.close()
    }
  }
})
