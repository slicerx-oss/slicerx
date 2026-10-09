// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Add it by hand" opens the brand grid with no brand chosen, even when the link was double clicked: the grid opens
// under the pointer, and the second click must not pick the tile that lands there. A tile's own click still picks it.
import { expect, plateReady, test } from './fixtures'

test('add it by hand starts with no brand chosen', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Needs a pointer')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.getByTestId('slice-machine-printer').click()
  await page.locator('.choose-add').click()
  const link = page.getByRole('button', { name: /Add it by hand/ }).first()
  await expect(link).toBeVisible()
  await link.dblclick()
  const brands = page.getByRole('radiogroup', { name: 'Brand' })
  await expect(brands.getByRole('radio').first()).toBeVisible()
  await expect(brands.getByRole('radio', { checked: true })).toHaveCount(0)
  await brands.getByRole('radio', { name: /Bambu Lab/ }).click()
  await expect(brands.getByRole('radio', { checked: true })).toHaveText(/Bambu Lab/)
})
