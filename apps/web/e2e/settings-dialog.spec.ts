// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Settings dialog fits the window: on a short one the header and the footer (About and Close) stay in view and only
// the body scrolls, and moving between sections moves nothing of the dialog itself.
import { type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
}

type Box = { x: number; y: number; width: number; height: number }
const same = (a: Box, b: Box) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) <= 0.5

for (const height of [768, 900]) {
  test(`at 1440 x ${height} the footer stays in view and sections move nothing`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop: a phone shows Settings full screen')
    await page.setViewportSize({ width: 1440, height })
    await open(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
    const parts = () => Promise.all([dialog, dialog.locator(':scope > .sx-dialog-h'), dialog.locator(':scope > .sx-dialog-foot'), nav].map(async (l) => (await l.boundingBox())!))
    const first = await parts()
    for (const name of await nav.getByRole('button').allTextContents()) {
      await nav.getByRole('button', { name: name.trim(), exact: true }).click()
      const now = await parts()
      now.forEach((b, i) => expect(same(b, first[i]!), `${name}: part ${i} moved`).toBe(true))
      // the footer's actions are inside the window and inside the dialog
      for (const label of [/^About /, /^Close$/]) {
        const b = (await dialog.locator(':scope > .sx-dialog-foot').getByRole('button', { name: label }).boundingBox())!
        expect(b.y + b.height).toBeLessThanOrEqual(Math.min(height, now[0]!.y + now[0]!.height))
      }
    }
    // a long section scrolls in the body, not the dialog
    await nav.getByRole('button', { name: 'Look and feel', exact: true }).click()
    const body = dialog.locator(':scope > .sx-dialog-body')
    if (height === 768) expect(await body.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true)
    await body.evaluate((e) => e.scrollTo(0, e.scrollHeight))
    expect(await dialog.evaluate((e) => e.scrollTop)).toBe(0)
    const after = await parts()
    after.forEach((b, i) => expect(same(b, first[i]!), `scrolled: part ${i} moved`).toBe(true))
    await expect(dialog.locator(':scope > .sx-dialog-foot').getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
  })
}
