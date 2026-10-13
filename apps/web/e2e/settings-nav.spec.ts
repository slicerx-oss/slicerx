// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings on a phone: the sections are one scrolling row. A tap on a tab never moves the row under the finger; an
// edge with more tabs past it fades instead of cutting a tab.
import { expect, plateReady, test } from './fixtures'

test('a tap on a Settings tab leaves the row where it is', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The sections are a scrolling row only at phone width')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.getByTestId('open-settings').click()
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav).toBeVisible()
  // at rest the far edge already fades: the row runs past it
  await expect(nav).toHaveAttribute('data-more-end', 'true')
  // part way along, so a tab sits cut at an edge
  await nav.evaluate((n) => n.scrollTo({ left: Math.min(60, n.scrollWidth - n.clientWidth) }))
  await expect(nav).toHaveAttribute('data-more-start', 'true')
  const before = await nav.evaluate((n) => n.scrollLeft)
  const tabs = nav.getByRole('button')
  const count = await tabs.count()
  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i)
    const box = await tab.boundingBox()
    const navBox = await nav.boundingBox()
    if (!box || !navBox || box.x + box.width / 2 < navBox.x || box.x + box.width / 2 > navBox.x + navBox.width) continue
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(tab).toHaveAttribute('aria-current', 'true')
    expect(await nav.evaluate((n) => n.scrollLeft)).toBe(before)
  }
})
