// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When the slicing engine cannot load, the browser build says so and offers to try again. It must never fall back to a
// slicer that makes G-code for nothing, as it once did without a word.
import { expect, test } from '@playwright/test'

const ENGINE = /sx_wasm[^/]*\.wasm(\?|$)/

test('a failed engine start shows the reason and Try again, which starts the app', async ({ page }) => {
  await page.route(ENGINE, (route) => route.fulfill({ status: 404, body: 'not found' }))
  await page.goto('./')
  const alert = page.getByRole('alert')
  await expect(alert.getByRole('heading', { name: 'The slicing engine could not start' })).toBeVisible({ timeout: 120_000 })
  // Nothing of the app is up behind it, so nothing can be sliced with a stand-in.
  await expect(page.locator('html[data-sx-ready]')).toHaveCount(0)
  await page.unroute(ENGINE)
  await alert.getByRole('button', { name: 'Try again' }).click()
  await page.locator('html[data-sx-ready]').waitFor({ state: 'attached', timeout: 120_000 })
  await expect(page.getByRole('alert').filter({ hasText: 'The slicing engine could not start' })).toHaveCount(0)
})
