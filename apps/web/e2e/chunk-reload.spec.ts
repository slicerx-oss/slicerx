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
  // The first fetch of the workspace's code fails as a dropped connection does; every later one goes through.
  await page.route(/\/static\/studio-[^/]+\.js$/, (route) => {
    if (dropped === 0) {
      dropped++
      return route.abort('internetdisconnected')
    }
    return route.continue()
  })
  let loads = 0
  page.on('load', () => loads++)
  await page.goto('./')
  // The plate loads in the workspace, which only renders once its code arrived.
  await page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: COLD_START_MS })
  await expect(page.getByText(/Plate 1\s*Layered X/).first()).toBeVisible()
  expect(dropped).toBe(1)
  expect(loads).toBe(2)
  await expect(page.getByText('did not load')).toHaveCount(0)
})
