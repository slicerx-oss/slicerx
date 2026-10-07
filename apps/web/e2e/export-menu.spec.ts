// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Export menu at the right end of the Objects actions opens whole: nothing in the side pane cuts it off, and
// it stays inside the window.
import { expect, plateReady, test } from './fixtures'

test('the Export menu is not cut off by the side pane', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the side pane sits beside the plate on a desktop window')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced' }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  const menu = page.getByRole('menu', { name: 'Export' })
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  const view = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width)
  // its items keep their one line instead of wrapping in a squeezed column
  const item = (await menu.getByRole('menuitem', { name: /Save project/ }).boundingBox())!
  expect(item.height).toBeLessThan(40)
  // the menu's own right edge is the topmost thing there: nothing clips or covers it
  const onTop = await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[role="menu"]')), { x: box.x + box.width - 6, y: box.y + 12 })
  expect(onTop).toBe(true)
  await page.screenshot({ path: info.outputPath('export-menu.png') })
})
