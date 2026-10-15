// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Run with SLICERX_CONFIG pointing to fixtures/assistant-edition.ts and SX_E2E_ASSISTANT_EDITION=1.
import { test, expect, viewportReady } from './fixtures'

test.skip(process.env['SX_E2E_ASSISTANT_EDITION'] !== '1', 'requires the assistant edition build')

for (const scheme of ['dark', 'light'] as const) {
  test(`edition assistant identity in chat and Settings (${scheme})`, async ({ page }) => {
    await page.addInitScript((scheme) => {
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, scheme, themeFollowsSystem: false }))
    }, scheme)
    await page.goto('./')
    await viewportReady(page)
    const tab = page.getByTestId('tab-mimir')
    await expect(tab).toHaveAccessibleName('yourmate')
    await tab.click()
    const chat = page.getByTestId('mimir-chat')
    await expect(chat).toBeVisible()
    await expect(chat.getByPlaceholder('Ask yourmate')).toBeVisible()
    await expect(chat.locator('.mimir-chat-head')).toContainText('yourmate')
    await expect(chat.locator('.mimir-chat-mark image')).toHaveAttribute('href', /^data:image\/svg\+xml,/)
    await expect(chat.getByTestId('mimir-ravens').locator('image')).toBeVisible()
    const accent = scheme === 'light' ? '#006b65' : '#63e6d4'
    await expect.poll(() => chat.evaluate((el) => getComputedStyle(el).getPropertyValue('--purple').trim())).toBe(accent)
    if (process.env['SX_SHOTS_DIR']) await page.screenshot({ path: `${process.env['SX_SHOTS_DIR']}/assistant-chat-${scheme}.png` })
    await page.evaluate(() => (window as any).__sx.setState({ settingsOpen: true, settingsSection: 'pilot' }))
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    await expect(page.getByTestId('settings-nav-pilot')).toHaveAccessibleName('yourmate')
    const section = settings.locator('[aria-labelledby="pilot-h"]')
    await expect(section).toContainText('yourmate answers questions')
    await expect.poll(() => section.evaluate((el) => getComputedStyle(el).getPropertyValue('--purple').trim())).toBe(accent)
    await expect(settings.getByText('About SlicerX', { exact: true })).toBeVisible()
    if (process.env['SX_SHOTS_DIR']) await page.screenshot({ path: `${process.env['SX_SHOTS_DIR']}/assistant-settings-${scheme}.png` })
    await settings.getByRole('button', { name: 'About SlicerX', exact: true }).click()
    const credit = page.getByTestId('about-attribution').getByRole('link')
    await expect(credit).toHaveText('Made possible by SlicerX')
    await expect(credit).toHaveAttribute('href', 'https://slicerx.app/support')
  })
}
