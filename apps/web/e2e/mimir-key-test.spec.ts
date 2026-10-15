// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > mimir > Use your own API key in the browser build: Test and connect calls the provider from the page with
// the typed key and shows its answer. (The desktop app makes the same call through its host instead.)
import { test, expect, viewportReady } from './fixtures'

test('the browser build tests a pasted key against the provider and shows its refusal', async ({ page }) => {
  const sent: { url: string; key: string | undefined }[] = []
  await page.route('https://api.anthropic.com/**', async (route) => {
    sent.push({ url: route.request().url(), key: route.request().headers()['x-api-key'] })
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    })
  })
  await page.addInitScript(() => {
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await viewportReady(page)
  await page.getByTestId('open-settings').first().click()
  await page.getByTestId('settings-nav-pilot').first().click()
  // with no mimir cloud in this build, the key providers show without a choice card first
  await page.getByTestId('pc-provider-anthropic').click()
  await page.getByTestId('pc-key').fill('sk-ant-test-invalid')
  await page.getByTestId('pc-test').click()
  const result = page.getByTestId('pc-result')
  await expect(result).toHaveText('The key was refused: invalid x-api-key')
  await expect(result).toHaveAttribute('data-state', 'failed')
  expect(sent).toEqual([{ url: 'https://api.anthropic.com/v1/models', key: 'sk-ant-test-invalid' }])
})
