// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The machine card in the Slice sidebar: printer, nozzle and plate type as chips that change in place, the plate type
// per plate, an export-only printer's status, and all of it by keyboard. The no-printer state is covered by the
// machine card unit test, since the web build always has its demo printers.
import { type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((p) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, ...p }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
  await expect(page.getByTestId('slice-machine-card')).toBeVisible()
}

test('the printer, nozzle and plate chips change them in place, in one 44 px row', async ({ page, isMobile }) => {
  await open(page)
  const card = page.getByTestId('slice-machine-card')
  const row = card.locator('.mc-row')
  if (!isMobile) expect(Math.round((await row.boundingBox())!.height)).toBe(44)
  // Printer: the list names each printer with its status, the current one checked.
  const printer = page.getByTestId('slice-machine-printer')
  await expect(printer).toHaveAttribute('data-tip-title', /mm$/)
  await printer.click()
  const options = page.getByTestId('slice-machine-printer-option')
  expect(await options.count()).toBeGreaterThan(1)
  await expect(page.locator('[data-testid="slice-machine-printer-option"][aria-pressed="true"]')).toHaveCount(1)
  await expect(page.getByTestId('slice-machine-printer-add')).toBeVisible()
  // Simple mode: no Printer settings in the list.
  await expect(page.getByTestId('slice-machine-printer-settings')).toHaveCount(0)
  const next = page.locator('[data-testid="slice-machine-printer-option"][aria-pressed="false"]').first()
  const name = ((await next.locator('.mc-opt').textContent()) ?? '').split(' ')[0]!
  const id = await next.getAttribute('data-printer-id')
  await next.click()
  await expect(page.getByRole('dialog', { name: 'Printer' })).toHaveCount(0)
  await expect(printer).toContainText(name)
  // Back to a printer whose nozzle can be picked here.
  await printer.click()
  await page.locator(`[data-testid="slice-machine-printer-option"]:not([data-printer-id="${id}"])`).first().click()
  // Nozzle.
  const nozzle = page.getByTestId('slice-machine-nozzle')
  await expect(nozzle).toHaveText(/^\d\.\d mm$/)
  await nozzle.click()
  const other = page.locator('[data-testid="slice-machine-nozzle-option"][aria-checked="false"]:not(:disabled)').first()
  if (await other.count()) {
    const mm = await other.getAttribute('data-nozzle')
    await other.click()
    await expect(nozzle).toHaveText(`${mm} mm`)
  } else {
    // The printer reports its nozzle: it is shown, and the others cannot be picked.
    await expect(page.getByRole('dialog', { name: 'Nozzle' })).toContainText('The printer reports this nozzle.')
    await page.keyboard.press('Escape')
  }
  // Plate type: the printer's default first, then each type.
  const plate = page.getByTestId('slice-machine-plate')
  await plate.click()
  const types = page.getByTestId('slice-machine-plate-option')
  await expect(types.first()).toHaveText(/^Printer default \(.+\)$/)
  await expect(types).toHaveCount(6)
  await page.locator('[data-testid="slice-machine-plate-option"][data-bed-type="cool"]').click()
  await expect(plate).toHaveText('Cool plate')
  await expect(plate).toHaveAttribute('data-bed-type', 'cool')
  // Every control of the card is on screen at once, with the status beside them.
  await expect(page.getByTestId('slice-machine-status')).toBeVisible()
})

test('the plate type is per plate', async ({ page }) => {
  await open(page, { printerId: 'bay-1' })
  const plate = page.getByTestId('slice-machine-plate')
  const first = (await plate.textContent()) ?? ''
  await page.getByRole('button', { name: 'Add plate' }).first().click()
  await plate.click()
  await page.locator('[data-testid="slice-machine-plate-option"][data-bed-type="smooth-pei"]').click()
  await expect(plate).toHaveText('Smooth PEI')
  const plates = page.getByRole('list', { name: 'Plates' })
  await plates.locator('.plate-card', { hasText: 'Plate 1' }).click()
  await expect(plate).toHaveText(first)
  await plates.locator('.plate-card', { hasText: 'Plate 2' }).click()
  await expect(plate).toHaveText('Smooth PEI')
  // Back to the printer's default.
  await plate.click()
  await page.locator('[data-testid="slice-machine-plate-option"][data-bed-type=""]').click()
  await expect(plate).toHaveText(first)
})

test('a printer with no connection reads Export only', async ({ page }) => {
  await open(page, { handPrinters: [A1_MINI], printerId: A1_MINI.id })
  await expect(page.getByTestId('slice-machine-printer')).toContainText('Desk A1 mini')
  await expect(page.getByTestId('slice-machine-status')).toHaveText('Export only')
})

test('Advanced folds the card to one summary line and lists Printer settings', async ({ page }) => {
  await open(page, { printerId: 'bay-1', settingsMode: 'advanced' })
  const card = page.getByTestId('slice-machine-card')
  await page.getByTestId('slice-machine-printer').click()
  await page.getByTestId('slice-machine-printer-settings').click()
  await expect(page.getByRole('dialog', { name: /Printer settings/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await card.getByRole('button', { name: 'Printer', exact: true }).click()
  await expect(card).toHaveAttribute('data-collapsed', 'true')
  await expect(card.locator('.sec-sum')).toHaveText(/^Bay 1, \d\.\d+ mm, .+, [A-Z][a-z ]+$/)
})

test('the card works by keyboard: Tab to a chip, Enter opens it, arrows move, Escape closes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Needs a keyboard')
  await open(page, { printerId: 'bay-1' })
  const plate = page.getByTestId('slice-machine-plate')
  const nozzle = page.getByTestId('slice-machine-nozzle')
  await nozzle.focus()
  await page.keyboard.press('Tab')
  await expect(plate).toBeFocused()
  await page.keyboard.press('Enter')
  const types = page.getByTestId('slice-machine-plate-option')
  await expect(types.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(types.nth(1)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Plate type' })).toHaveCount(0)
  await expect(plate).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('End')
  await expect(types.last()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(plate).toHaveText('High temp plate')
})

test('Simple at 1440 by 900 with nothing selected has Supports on screen', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop size')
  await open(page, { printerId: 'bay-1' })
  await page.keyboard.press('Escape')
  await page.locator('.vp').click({ position: { x: 5, y: 300 } })
  const supports = page.getByRole('radiogroup', { name: 'Supports' })
  await expect(supports).toBeVisible()
  const box = (await supports.boundingBox())!
  const foot = (await page.locator('.sx-rail-foot').first().boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(foot.y)
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: the machine card, its popovers, folded and export only, light and dark', async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await open(page, { printerId: 'bay-1' })
  const sx = (p: unknown) => page.evaluate((x) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState(x), p)
  const card = page.getByTestId('slice-machine-card')
  const shoot = async (name: string) => {
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/machine-${name}-${width}.png` })
  }
  for (const scheme of ['light', 'dark'] as const) {
    await sx({ scheme, themeFollowsSystem: false, settingsMode: 'simple' })
    await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    await shoot(`card-${scheme}`)
    for (const chip of ['printer', 'nozzle', 'plate'] as const) {
      await page.getByTestId(`slice-machine-${chip}`).click()
      await shoot(`${chip}-${scheme}`)
      await page.keyboard.press('Escape')
    }
    await sx({ settingsMode: 'advanced' })
    await card.getByRole('button', { name: 'Printer', exact: true }).click()
    await shoot(`folded-${scheme}`)
    await card.getByRole('button', { name: 'Printer', exact: true }).click()
  }
})
