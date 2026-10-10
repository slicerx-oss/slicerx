// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone layout is a touch screen 900 px wide or less: the document root says so with data-phone, and only there.
import { expect, plateReady, test } from './fixtures'

test('the root is marked a phone on a phone only', async ({ page, isMobile }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await expect.poll(() => page.locator('html').evaluate((el) => el.hasAttribute('data-phone'))).toBe(isMobile)
  if (isMobile) return
  // a narrow desktop window, with a mouse, keeps the full layout
  await page.setViewportSize({ width: 800, height: 900 })
  await expect.poll(() => page.locator('html').evaluate((el) => el.hasAttribute('data-phone'))).toBe(false)
})
