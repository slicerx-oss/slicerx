// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Touch has no hover: a long press shows a control's tip above the finger, and releasing does not tap the control.
import { type Locator } from '@playwright/test'
import { expect, openSheet, plateReady, test, viewportReady } from './fixtures'

test('a long press shows the tip and the release does not press the control', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch project')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  // the object's print toggle in the Slice sheet: a phone views and prints, so it has no plate tools to hold
  await openSheet(page)
  const print = page.getByTestId('object-row').first().getByTestId('object-printable')
  const cdp = await page.context().newCDPSession(page)
  const centerOf = async (button: Locator) => {
    const box = (await button.boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const touchOn = (button: Locator) => async (type: 'touchStart' | 'touchEnd') => {
    const { x, y } = await centerOf(button)
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
  }
  // A tap is a finger down for 60 ms, as a real one is: Playwright's own tap() lifts in the same millisecond, and Chromium on
  // Linux then sends the click to the toolbar and not the button.
  const tap = async (button: Locator) => {
    const touch = touchOn(button)
    await touch('touchStart')
    await page.waitForTimeout(60)
    await touch('touchEnd')
  }
  // A short tap presses the toggle and shows no tip. The first touches on a fresh page only wake it up: Chromium's touch
  // hit test is stale until the page has had a mouse event, so one click on the row's name comes first, and the tap
  // repeats while the toggle is not pressed.
  await page.getByTestId('object-row').first().getByTestId('object-select').click()
  await expect(async () => {
    if ((await print.getAttribute('aria-pressed')) !== 'true') await tap(print)
    await expect(print).toHaveAttribute('aria-pressed', 'true', { timeout: 1500 })
  }).toPass({ timeout: 20_000 })
  await expect(page.locator('#sx-tip')).toHaveCount(0)
  // Put it back, then hold.
  await print.click()
  await expect(print).toHaveAttribute('aria-pressed', 'false')
  // the click leaves the mouse over the toggle; away from it, so the tip below can only come from the finger
  await page.mouse.move(1, 1)
  await expect(page.locator('#sx-tip')).toHaveCount(0)
  const hold = touchOn(print)
  await hold('touchStart')
  await expect(page.locator('#sx-tip')).toContainText('leave it out of the print', { timeout: 3000 })
  await hold('touchEnd')
  await expect(page.locator('#sx-tip')).toHaveCount(0)
  await expect(print).toHaveAttribute('aria-pressed', 'false')
})
