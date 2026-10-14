// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A 60-character name (the longest a preset rename takes) for a printer and for printer, filament and process presets:
// it ellipsizes in a closed control, reads whole in the tooltip on hover and focus and in the open list, and nothing
// runs past the window at 390, 1100 or 1440 px.
import type { Page } from '@playwright/test'
import { closeSheet, expect, openSheet, test } from './fixtures'

const LONG = 'Workshop enclosure printer with the hardened nozzle, bay 12 A'
const PRINTER = { id: 'e2e-long-name', name: LONG, profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }
const name = (kind: string, n = 1) => `${kind} ${n} for the workshop enclosure with the hardened nozzle`.slice(0, 60)

async function open(page: Page): Promise<void> {
  await page.addInitScript((printer) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'expert', pilot: { mode: 'off' }, handPrinters: [printer], printerId: printer.id }))
  }, PRINTER)
  await page.goto('./')
  await page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached' })
  // Saved presets live in the browser's preset store; Settings > Presets reads them from there.
  const presets = ['printer', 'filament', 'process', 'process'].map((kind, i) => ({ id: `e2e-long-${i}`, kind, name: name(kind, i), values: {}, createdAt: 1, updatedAt: 1 }))
  await page.evaluate(
    (rows) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('slicerx-presets', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('presets', { keyPath: 'id' })
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction('presets', 'readwrite')
          for (const r of rows) tx.objectStore('presets').put(r)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
    presets,
  )
}

async function noSideways(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  const bodies = page.locator('.pane-body, .sx-dialog-body')
  for (let i = 0; i < (await bodies.count()); i++) {
    const b = bodies.nth(i)
    if (!(await b.isVisible())) continue
    expect(await b.evaluate((el) => el.scrollWidth - el.clientWidth), await b.evaluate((el) => el.className)).toBeLessThanOrEqual(0)
  }
}

const tip = (page: Page) => page.locator('.sx-tip[data-ready]')

for (const width of [1440, 1100, 390]) {
  test(`a 60-character name ellipsizes closed and reads whole on hover, focus and in the list at ${width} px`, async ({ page, isMobile }) => {
    test.skip(isMobile !== (width === 390), width === 390 ? 'phone width' : 'desktop widths')
    if (!isMobile) await page.setViewportSize({ width, height: 900 })
    await open(page)
    if (isMobile) await openSheet(page)
    else {
      const opener = page.getByRole('button', { name: 'Open Printer and settings' })
      if (await opener.isVisible()) await opener.click()
    }
    // The printer: the card ellipsizes the name; hover and focus show it whole; the list shows it whole.
    const printer = page.getByTestId('slice-machine-printer')
    const shown = printer.locator('.printer-name')
    await expect(shown).toBeVisible()
    expect(await shown.evaluate((el) => [getComputedStyle(el).textOverflow, el.scrollWidth > el.clientWidth])).toEqual(['ellipsis', true])
    if (!isMobile) {
      await printer.hover()
      await expect(tip(page)).toContainText(LONG)
      await page.mouse.move(700, 450)
      await printer.focus()
      await expect(tip(page)).toContainText(LONG)
    }
    await noSideways(page)
    await printer.click()
    const option = page.locator(`[data-testid="slice-machine-printer-option"][data-printer-id="${PRINTER.id}"] .mc-opt`)
    await expect(option).toContainText(LONG)
    expect(await option.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    await page.keyboard.press('Escape')

    // The presets: the list shows every name whole, and the compare picker ellipsizes it while closed.
    if (isMobile) await closeSheet(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('settings-nav-presets').click()
    for (const kind of ['printer', 'filament', 'process']) {
      const row = dialog.locator('.preset-name b', { hasText: name(kind, kind === 'printer' ? 0 : kind === 'filament' ? 1 : 2) })
      await expect(row).toBeVisible()
      expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    }
    const pick = dialog.locator('#cmp-a')
    await pick.scrollIntoViewIfNeeded()
    await pick.selectOption('e2e-long-2')
    expect(await pick.locator('option:checked').textContent()).toBe(name('process', 2))
    const face = dialog.locator('.cmp-pick .sx-select-face > span').first()
    await expect(face).toHaveText(name('process', 2))
    expect(await face.evaluate((el) => [getComputedStyle(el).textOverflow, el.scrollWidth > el.clientWidth])).toEqual(['ellipsis', true])
    if (!isMobile) {
      await pick.hover()
      await expect(tip(page)).toContainText(name('process', 2))
    }
    await noSideways(page)
  })
}
