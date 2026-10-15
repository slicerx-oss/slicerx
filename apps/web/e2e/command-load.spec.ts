// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, plateReady, test } from './fixtures'

test('the command bar keeps typing and reopening usable while search downloads', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', cadTools: true }))
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let requested = false
  await page.route(/\/command-results-[^/]+\.js$/, async (route) => {
    requested = true
    await held
    await route.continue()
  })
  try {
    await page.goto('./')
    await plateReady(page)
    expect(requested).toBe(false)
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.locator('.sx-palette-input')
    await expect(input).toBeFocused()
    await page.keyboard.type('clone')
    await expect(input).toHaveValue('clone')
    await expect.poll(() => requested).toBe(true)
    await expect(page.locator('.sx-palette-item')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(input).toBeHidden()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')
    await page.keyboard.type('clone')
    release()
    await expect(page.locator('.sx-palette-item', { hasText: 'Duplicate the selected objects' }).first()).toBeVisible()
    await expect(input).toHaveValue('clone')
    await expect(input).toBeFocused()
    const rows = page.getByTestId('object-row')
    const before = await rows.count()
    await page.keyboard.press('Enter')
    await expect(input).toBeHidden()
    await expect(rows).toHaveCount(before + 1)
  } finally {
    release()
  }
})
