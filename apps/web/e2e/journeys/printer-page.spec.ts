// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: a printer's own web page opens from its card. Against a real sx-link and the Klipper mock, a saved Voron
// on the local network gets "Open web interface" in its card menu, and choosing it opens the page the printer serves.
// The printer catalog that checks the address loads on first use (lib/links.ts), so this also covers that import. It
// runs at desktop width and again with the window narrowed to 390 px, where Printers sits under More tabs. The address
// rules themselves are unit tested (packages/app/test/printer-web-ui.test.ts, the catalog's web-ui.test.ts).
// The harness, with this file's own hub on a free loopback port, is in e2e/bridge-hub.ts.
// Needs SX_LINK_BIN (a built sx-link); the tests skip without it.
import type { Page } from '@playwright/test'
import { ONBOARDING_VERSION } from '../../../../packages/app/src/first-run/onboarding.ts'
import { connectApp, hub, useBridge } from '../bridge-hub'
import { expect, journey as test } from '../journey'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, firstRun: { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: null, version: ONBOARDING_VERSION } } })

const NAME = 'Bench'

useBridge(['moonraker'], async () => {
  await hub.admin.addPrinter({ id: 'bench', name: NAME, plugin: 'moonraker', host: '127.0.0.1', port: hub.ports['moonraker'] ?? 0 }, { vendor: 'Voron', model: '2.4' })
})

/** The pages the app asked the browser to open: the browser build opens a printer's page with window.open. */
async function recordOpens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const opened: string[] = []
    Object.assign(window, { __sxOpened: opened })
    window.open = ((url?: string | URL) => {
      opened.push(String(url))
      return null
    }) as typeof window.open
  })
}

/** Opens the card menu, chooses "Open web interface" and checks the page the app opened. */
async function openFromCard(page: Page, opened: () => Promise<string[]>, count: number): Promise<void> {
  const card = page.getByRole('article', { name: new RegExp(`^${NAME},`) })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByTestId('printer-card-options').click()
  const item = page.getByTestId('printer-card-web-ui')
  await expect(item).toHaveText('Open web interface')
  await item.click()
  // Mainsail on the printer's own host, port 80.
  await expect.poll(async () => (await opened()).length).toBe(count)
  expect((await opened()).at(-1)).toBe('http://127.0.0.1/')
  await expect(page.getByTestId('toast').filter({ hasText: 'not on your local network' })).toHaveCount(0)
}

const opened = (page: Page) => () => page.evaluate(() => (window as unknown as { __sxOpened: string[] }).__sxOpened)

// Serial, on one page: the second step narrows the window the first one paired.
test("the card menu opens the printer's web page at 1280 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await recordOpens(page)
  await connectApp(page)
  await page.getByRole('button', { name: 'Printers', exact: true }).first().click()
  await openFromCard(page, opened(page), 1)
})

test("the card menu opens it at 390 px, with Printers under More tabs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'More tabs' }).click()
  await page.getByRole('menuitem', { name: /Printers/ }).click()
  await openFromCard(page, opened(page), 2)
})
