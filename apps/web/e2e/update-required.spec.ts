// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A required update (the feed's min_version above this version) holds the app: Escape does not close the sheet, no
// shortcut reaches the app behind it, and only Quit or Update now answer it. The e2e build reads the feed from the page.
import { expect, plateReady, test } from './fixtures'

test('the required update sheet ignores Escape and holds every key', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await page.addInitScript(() => {
    ;(window as unknown as { __sxUpdateFeed: unknown }).__sxUpdateFeed = { version: '9.9.9', notes: 'A fix for a known problem.', minVersion: '9.9.9', required: true }
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const sheet = page.getByRole('dialog').filter({ hasText: 'This version has a known problem' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Later' })).toHaveCount(0)
  // Escape, pressed again and again: Chromium closes a dialog on a second Escape unless the page stops it.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
  await expect(sheet).toBeVisible()
  // WebView2 closed it on Escape with nothing clicked yet (no user activation, so no cancel event to stop). Whatever
  // closes the native dialog, the sheet comes straight back.
  await page.evaluate(() => (document.querySelector('dialog[open]') as HTMLDialogElement).close())
  await expect(sheet).toBeVisible()
  // The app's shortcuts do nothing behind it: the command bar, the shortcuts list, removing the selected object.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.press('Shift+?')
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toHaveCount(1)
  // Tab stays inside the sheet, and its own buttons answer.
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true)
  await sheet.getByRole('button', { name: 'Quit' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sxQuit?: boolean }).__sxQuit === true)).toBe(true)
})
