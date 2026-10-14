// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part of the app's code that fails to download while the app starts (the connection drops for a moment) does not
// leave the workspace stuck: the browser keeps a failed module for the rest of the page, so the app reloads once and
// comes up with its plate.
import { expect } from '@playwright/test'
import { COLD_START_MS, test } from './fixtures'

test('a workspace whose code failed to download comes back after one reload', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  let dropped = 0
  // The first fetch of the workspace's code fails as a dropped connection does; every later one goes through. A reset,
  // not a lost network: the fixtures reload a page whose network changed (NETWORK_CHANGED), and that reload would
  // race the app's own one, the reload this test is about.
  await page.route(/\/static\/studio-[^/]+\.js$/, (route) => {
    if (dropped === 0) {
      dropped++
      return route.abort('connectionreset')
    }
    return route.continue()
  })
  let loads = 0
  page.on('load', () => loads++)
  await page.goto('./')
  // The plate loads in the workspace, which only renders once its code arrived.
  await page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: COLD_START_MS })
  // The plate chip names the plate only, so the workspace is up once it reads Plate 1.
  await expect(page.getByTestId('plate-chip')).toContainText('Plate 1')
  expect(dropped).toBe(1)
  expect(loads).toBe(2)
  await expect(page.getByText('did not load')).toHaveCount(0)
})

type Sx = { setState(p: unknown): void }

test('a workspace whose code never downloads says so once, in the workspace, with no toast over it', async ({ page, isMobile }) => {
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  // Every fetch fails: the one reload does not help. A reset, as above: a lost network would have the fixtures reload
  // the page too, and that reload races the app's own one.
  await page.route(/\/static\/studio-[^/]+\.js$/, (route) => route.abort('connectionreset'))
  await page.goto('./')
  await expect(page.getByRole('heading', { name: /did not load/ })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  // The toast waits a moment for the workspace, then stays away.
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('toast')).toHaveCount(0)
  // The message fills the window down to the gutter; a phone has no gutter, and the frame is the whole screen.
  const frame = (await page.locator('.sx-frame').boundingBox())!
  expect(Math.round(page.viewportSize()!.height - (frame.y + frame.height))).toBe(isMobile ? 0 : 16)
})

test('a dialog whose code did not download leaves the workspace up and says so in a toast', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.route(/\/static\/about-[^/]+\.js$/, (route) => route.abort('internetdisconnected'))
  let loads = 0
  page.on('load', () => loads++)
  const ready = () => page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: COLD_START_MS })
  const about = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ aboutOpen: true }))
  await page.goto('./')
  await ready()
  // With nothing unsaved the first failure reloads the page, which fetches the code again.
  await about()
  await expect.poll(() => loads).toBe(2)
  await ready()
  // It fails again within half a minute: no second reload, a toast instead, and the workspace keeps working.
  await about()
  const toast = page.getByTestId('toast').filter({ hasText: /Part of .* did not load/ })
  await expect(toast).toBeVisible()
  await expect(toast.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /did not load/ })).toHaveCount(0)
  // The plate chip names the plate only, so the workspace is up once it reads Plate 1.
  await expect(page.getByTestId('plate-chip')).toContainText('Plate 1')
  expect(loads).toBe(2)
})
