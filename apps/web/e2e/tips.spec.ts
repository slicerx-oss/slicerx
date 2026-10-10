// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tip never covers the next thing a person presses: it takes no clicks, and it closes once the pointer leaves its
// control, even when the pointer crosses the tip on the way.
import { expect, plateReady, test } from './fixtures'

test('the lock button\'s tip closes as the pointer moves to the name under it, and the name takes the click', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const row = page.getByTestId('object-row').first()
  const name = row.getByTestId('object-select')
  const lock = row.getByTestId('object-lock')
  await page.keyboard.press('Escape')
  await expect(name).toHaveAttribute('aria-pressed', 'false')
  await row.locator('.obj-row').hover()
  await lock.hover()
  const tip = page.locator('#sx-tip')
  await expect(tip).toContainText('Keep it from moving')
  // The tip takes no pointer: a press where it is drawn lands on what is under it.
  const t = (await tip.boundingBox())!
  const [cx, cy] = [t.x + t.width / 2, t.y + t.height / 2]
  expect(await tip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
  expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest('#sx-tip')), [cx, cy])).toBe(false)
  // Across the tip to the name: the lock's tip closes once the pointer leaves the button, and the name takes the click.
  await page.mouse.move(cx, cy, { steps: 4 })
  await expect(tip.filter({ hasText: 'Keep it from moving' })).toHaveCount(0)
  const n = (await name.boundingBox())!
  await page.mouse.click(n.x + n.width / 2, n.y + n.height / 2)
  await expect(name).toHaveAttribute('aria-pressed', 'true')
})
