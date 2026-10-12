// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A startup script that fails to download leaves no app at all: the page reloads once and comes up. Seen on a busy
// runner as net::ERR_NO_BUFFER_SPACE on a shared startup chunk, which left the page empty until the test gave up.
// The plain test, not ./fixtures: their cold start wait reloads a page itself, and this checks the page's own reload.
import { expect, test } from '@playwright/test'

test.describe('a startup script that does not download', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop start')

  for (const [what, file] of [['the entry', /\/static\/index-[^/]+\.js$/], ['a chunk the entry imports', /\/static\/jsx-runtime-[^/]+\.js$/]] as const) {
    test(`${what}: the page reloads once and the app comes up`, async ({ page }) => {
      let dropped = 0
      await page.route(file, (route) => {
        if (dropped === 0) {
          dropped++
          return route.abort('failed')
        }
        return route.continue()
      })
      // the reload comes before the first page finishes loading, so count navigations, not load events
      let loads = 0
      page.on('framenavigated', (f) => f === page.mainFrame() && loads++)
      await page.goto('./')
      await expect(page.locator('html[data-sx-ready]')).toHaveCount(1, { timeout: 120_000 })
      expect(dropped).toBe(1)
      expect(loads).toBe(2)
    })
  }

  test('a script that keeps failing does not reload over and over', async ({ page }) => {
    await page.route(/\/static\/index-[^/]+\.js$/, (route) => route.abort('failed'))
    let loads = 0
    page.on('framenavigated', (f) => f === page.mainFrame() && loads++)
    await page.goto('./')
    await expect.poll(() => loads).toBe(2)
    await page.waitForTimeout(3000)
    expect(loads).toBe(2)
    await expect(page.locator('html[data-sx-ready]')).toHaveCount(0)
  })
})
