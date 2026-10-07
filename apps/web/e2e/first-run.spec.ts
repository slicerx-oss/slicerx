// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First-run setup on a fresh install: the printer scan, the slicer question, then setting up mimir.
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function fresh(page: Page): Promise<void> {
  // A fresh install: nothing stored, so setup opens by itself on the printer scan.
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Find your printer' })).toBeVisible()
  // Four steps: the printer, the slicer you use now, what the plate tab opens in, and mimir (until mimir is turned on or off).
  await expect(page.locator('#fr-step-label')).toHaveText('Step 1 of 4')
}

async function noHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
}

test('the scan finds the printer, the connection tests itself, then the slicer question', async ({ page }) => {
  await fresh(page)
  await noHorizontalScroll(page)

  // Nothing is searched until asked; then the scan lists what the demo network announces, with what each printer reported.
  await expect(page.getByRole('radiogroup', { name: 'Printers found' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Search my network' }).click()
  const found = page.getByRole('radiogroup', { name: 'Printers found' }).getByRole('radio')
  await expect(found).toHaveCount(6)
  const x1 = found.filter({ hasText: 'X1 Carbon' })
  await expect(x1).toContainText('AMS')
  await expect(x1).toContainText('192.0.2.11')
  await x1.click()
  await expect(x1).toHaveAttribute('aria-checked', 'true')

  // Bambu LAN asks for the serial number and the access code; the test starts once both are in.
  await page.getByRole('textbox', { name: /Serial number/ }).fill('01S00A987654321')
  const code = page.getByRole('textbox', { name: /Access code/ })
  await code.fill('12345678')
  // The access code is read off a screen, not a password: shown as typed.
  await expect(code).toHaveAttribute('type', 'text')
  await expect(page.locator('.fr-found-ok')).toContainText('Found it.')
  await expect(page.locator('.fr-test .fr-ok')).toContainText('Connected')
  // A test past 1.2 s lands the ravens on a trail of three rows instead of the list of four steps (a slower runner
  // gets the trail): either way, every row passed.
  const rows = page.locator('.fr-checks li, .fr-trail li')
  await expect(rows.first()).toBeVisible()
  await expect(rows).toHaveCount((await page.locator('.fr-trail').count()) > 0 ? 3 : 4)
  await expect(page.locator('.fr-checks li:not([data-state="ok"]), .fr-trail li:not([data-state="ok"])')).toHaveCount(0)
  await expect(page.locator('.fr-read')).toContainText('X1 Carbon')
  await expect(page.locator('.fr-read')).toContainText('AMS')
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Continue' }).click()

  // Which slicer: four cards, "something else" preselected, the pick applied live.
  await expect(page.locator('#fr-step-label')).toHaveText('Step 2 of 4')
  await expect(page.getByRole('heading', { name: 'Which slicer do you use now?' })).toBeVisible()
  const cards = page.getByRole('radiogroup', { name: 'Slicer you use now' }).getByRole('radio')
  await expect(cards).toHaveCount(4)
  await expect(cards.nth(0)).toContainText('Bambu Studio')
  await expect(cards.nth(1)).toContainText('OrcaSlicer')
  await expect(cards.nth(2)).toContainText('PrusaSlicer')
  await expect(cards.nth(3)).toHaveAttribute('aria-checked', 'true')
  await cards.nth(0).click()
  await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'bambu-studio')
  await expect(page.getByText('Bring your Bambu Studio presets')).toBeVisible()
  await expect(page.getByText('SlicerX is not affiliated with them.', { exact: false })).toBeVisible()
  // Arrow keys move the selection.
  await cards.nth(0).press('ArrowDown')
  await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true')
  await cards.nth(1).press('ArrowUp')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'bambu-studio')
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()

  // Then what the plate tab opens in: Slicing stays chosen.
  await expect(page.locator('#fr-step-label')).toHaveText('Step 3 of 4')
  await expect(page.getByRole('heading', { name: /What do you want .* to open in\?/ })).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Slicing/ })).toHaveAttribute('aria-checked', 'true')
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()

  // Then mimir: setting it up is offered, and the plate opens from there.
  await expect(page.locator('#fr-step-label')).toHaveText('Step 4 of 4')
  await expect(page.getByRole('heading', { name: 'Set up mimir' })).toBeVisible()
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Open the plate' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)

  // The Bambu style names the Printers workspace Device and keeps the choice and the printer.
  await expect(page.locator('.sx-tab', { hasText: 'Device' })).toHaveCount(1)
  const stored = await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1') ?? '')
  const prefs = JSON.parse(stored) as { lookAndFeel: { id: string }; firstRun: { completedAt: string | null; printerId: string | null } }
  expect(prefs.lookAndFeel.id).toBe('bambu-studio')
  expect(prefs.firstRun.completedAt).not.toBeNull()
  expect(prefs.firstRun.printerId).toBe('bay-1')
  // The access code never lands in storage.
  const all = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'))
  expect(all).not.toContain('12345678')

  await page.reload()
  await expect(page.locator('.sx-tab', { hasText: 'Device' })).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Find your printer' })).toHaveCount(0)
})

test('adding by hand: a failed test names the step and cause, and setup can continue without it', async ({ page }) => {
  await fresh(page)
  await page.getByRole('button', { name: 'Not listed? Add it by hand' }).click()
  await expect(page.getByRole('heading', { name: 'Add your printer' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search brand or model' }).fill('voron 2.4')
  await page.locator('.fr-hits .fr-hit').first().click()
  await expect(page.getByRole('radio', { name: /Moonraker/ })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('textbox', { name: /IP address/ }).fill('192.0.2.77')
  await page.getByRole('button', { name: 'Test connection' }).first().click()
  await expect(page.locator('.fr-test-bad-h')).toContainText('No answer from 192.0.2.77.')
  await expect(page.locator('.fr-foot').getByRole('button', { name: 'Test again' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue without testing' }).click()
  await expect(page.getByRole('heading', { name: 'Which slicer do you use now?' })).toBeVisible()
})

test('Escape asks before leaving, and Settings brings the slicer screen back', async ({ page }) => {
  await fresh(page)
  await page.keyboard.press('Escape')
  const dialog = page.getByRole('dialog', { name: 'Leave setup?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('You can finish it later from Settings.')
  await dialog.getByRole('button', { name: 'Stay' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 1 of 4')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Leave setup?' }).getByRole('button', { name: 'Leave' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('change look and feel')
  await page.keyboard.press('Enter')
  await expect(page.locator('#fr-step-label')).toHaveText('Step 2 of 4')
})

test('Skip, use defaults closes setup; mimir shows and opens the connect step until a model is connected', async ({ page }) => {
  await fresh(page)
  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await page.locator('.mimir-btn').click()
  await expect(page.locator('.mimir-connect')).toContainText('Nothing is sent until you connect')
  await expect(page.locator('.mimir-connect').getByRole('radiogroup', { name: 'Model provider' })).toBeVisible()
  await page.locator('.mimir-btn').click()
  await expect(page.locator('.mimir-dock')).toHaveCount(0)
  // A question offers mimir, and choosing it opens the same step with the question waiting.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('why is my first layer rough')
  await page.locator('.sx-palette-item', { hasText: 'Ask mimir: why is my first layer rough' }).click()
  await expect(page.locator('.mimir-connect')).toContainText('why is my first layer rough')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('connect mimir')
  await page.locator('.sx-palette-item', { hasText: 'Connect mimir' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('heading', { name: 'mimir' })).toBeVisible()
  await expect(dialog.getByRole('radiogroup', { name: 'Model provider' })).toBeVisible()
})

test('choosing CAD design opens the plate in Design, now and on the next launch, and Settings changes it', async ({ page }) => {
  await fresh(page)
  // Straight to the open step: no printer, the slicer as it is.
  await page.getByRole('button', { name: 'I do not have a printer yet' }).first().click()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 2 of 4')
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 3 of 4')
  const cad = page.getByRole('radio', { name: /^CAD design/ })
  await cad.click()
  await expect(cad).toHaveAttribute('aria-checked', 'true')
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await page.locator('.fr-foot').getByRole('button', { name: 'Open the plate' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
  await page.reload()
  await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
  // Settings > Look and feel changes the default; the session stays where it is.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
  const row = page.getByRole('radiogroup', { name: 'Open models in' })
  await expect(row.getByRole('radio', { name: 'CAD design' })).toHaveAttribute('aria-checked', 'true')
  await row.getByRole('radio', { name: 'Slicing' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
  await page.reload()
  await expect(page.locator('.sx-tab[data-mode="slice"]')).toHaveAttribute('aria-current', 'page')
})
