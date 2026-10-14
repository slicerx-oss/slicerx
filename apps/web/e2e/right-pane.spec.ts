// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice's right pane starts shut and opens when a slice finishes. Once the person shuts it by hand it stays shut through
// that project's slices until they open it again, and a new session starts it shut. While it is shut, its edge tab
// glows when something in it wants a look. Long names stay on one line, cut in the middle.
import { type Page } from '@playwright/test'
import { expect, plateReady, sliceCount, sliced, test } from './fixtures'

type Sx = { getState(): { plate: { name: string }[]; slice: { status: string; result: { warnings: unknown[] } } }; setState(p: unknown): void }

/** The starter is on the plate (plateReady looks in the objects list, which is shut here). */
const plateIn = (page: Page) => expect.poll(() => page.evaluate(() => (window as unknown as { __sx?: Sx }).__sx?.getState().plate.some((p) => p.name.includes('Layered X')) ?? false), { timeout: 120_000 }).toBe(true)
const tab = (page: Page) => page.getByTestId('edge-tab-right')

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((p) => {
    // The shut default people get; the other specs start with the pane open.
    sessionStorage.setItem('sx-right-pane', 'shut')
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, printerId: 'bay-1', ...p }))
  }, prefs)
  await page.goto('./')
  await plateIn(page)
}

async function slice(page: Page): Promise<void> {
  const n = await sliceCount(page)
  await page.mouse.click(700, 450)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
}

test.describe('the right pane', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width: on a phone the panes are sheets')

  test('starts shut, and a finished slice opens it with the summary', async ({ page }) => {
    await open(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('slice-summary')).toHaveCount(0)
    await slice(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('slice-summary')).toBeVisible()
    await expect(tab(page)).not.toHaveAttribute('data-attention', /./)
  })

  test('shut by hand, it stays shut through the project\'s slices until opened again', async ({ page }) => {
    await open(page)
    await slice(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'true')
    await tab(page).click()
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
    await slice(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
    // Opened by hand again, the next slice leaves it open; shut by the key, it stays shut again.
    await tab(page).click()
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'true')
    await slice(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'true')
    await page.mouse.move(700, 300)
    await page.keyboard.press('BracketRight')
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
    await slice(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
  })

  // Its own test: the one above already chains four slices and four resizes of the view.
  test('not kept between sessions: opened by hand, a reload starts it shut', async ({ page }) => {
    await open(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
    await tab(page).click()
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'true')
    await page.reload()
    await plateIn(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
  })

  test('shut by hand, it glows for a slice with warnings until it is opened', async ({ page }) => {
    await open(page)
    await slice(page)
    await tab(page).click()
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: Sx }).__sx
      const s = sx.getState().slice
      sx.setState({ slice: { ...s, result: { ...s.result, id: 'warned', warnings: [{ code: 'thin_wall', message: 'A wall is thinner than the nozzle.' }] } } })
    })
    await expect(tab(page)).toHaveAttribute('data-attention', 'true')
    await expect(tab(page)).toHaveAttribute('aria-label', /needs a look/)
    await tab(page).click()
    await expect(page.getByTestId('slice-summary')).toBeVisible()
    await expect(tab(page)).not.toHaveAttribute('data-attention', /./)
    // Seen: shutting it again does not bring the glow back for the same warnings.
    await tab(page).click()
    await expect(tab(page)).not.toHaveAttribute('data-attention', /./)
  })

  test('glows for an object off the bed', async ({ page }) => {
    await open(page)
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): { plate: { transform: number[] }[] }; setState(p: unknown): void } }).__sx
      const [o, ...rest] = sx.getState().plate
      const t = [...o!.transform]
      t[12] = 900
      sx.setState({ plate: [{ ...o, transform: t }, ...rest] })
    })
    await expect(tab(page)).toHaveAttribute('data-attention', 'true')
  })

  test('under reduced motion the glow is still, not breathing', async ({ page }) => {
    await open(page, { motion: 'reduced' })
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): { plate: { transform: number[] }[] }; setState(p: unknown): void } }).__sx
      const [o, ...rest] = sx.getState().plate
      const t = [...o!.transform]
      t[12] = 900
      sx.setState({ plate: [{ ...o, transform: t }, ...rest] })
    })
    await expect(tab(page)).toHaveAttribute('data-attention', 'true')
    expect(await tab(page).evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  })
})

test('a 120-character file name stays on one line in the objects list and Print, and the plate chip names the plate only', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop width')
  const long = `${'Very_long_model_name_from_a_marketplace_download_'.repeat(2)}with_extras_v2_final.stl`.slice(-120)
  const printer = { id: 'e2e-long', name: 'H2D 0.4 from CHAINSAW_MAN_-_POCHITA_-_KEYCHAIN_WITH_A_VERY_LONG_PROJECT_NAME', profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }
  await page.addInitScript(() => sessionStorage.setItem('sx-right-pane', 'open'))
  await page.addInitScript((p) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, autoSlice: true, autoSliceBySize: false, handPrinters: [p], printerId: p.id }))
  }, printer)
  await page.goto('./')
  await plateReady(page)
  await page.evaluate((name) => {
    const sx = (window as unknown as { __sx: { getState(): { plate: { name: string }[] }; setState(p: unknown): void } }).__sx
    const [o, ...rest] = sx.getState().plate
    sx.setState({ plate: [{ ...o, name }, ...rest] })
  }, long)
  await expect(page.getByTestId('object-name').first()).toHaveText(long)
  // Every control or chip carrying a name keeps it inside, on one line.
  const inside = async (selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      const r = el.getBoundingClientRect()
      const host = el.parentElement?.closest('button, .obj-row, .sx-block, aside')
      const parent = (host ?? el.parentElement!).getBoundingClientRect()
      return { oneLine: r.height < 40, fits: r.left >= parent.left - 0.5 && r.right <= parent.right + 0.5 }
    })
  for (const sel of ['[data-testid="object-name"]', '[data-testid="slice-machine-printer"] .printer-name']) {
    expect(await inside(sel), sel).toEqual({ oneLine: true, fits: true })
  }
  // The plate chip names the plate, not the object, and the view has no size chip: the scale tool has the size.
  await expect(page.getByTestId('plate-chip')).toHaveText('Plate 1')
  await expect(page.locator('.vp .dims')).toHaveCount(0)
  // The export-only printer's footer action and the summary's Export name the printer without its project.
  await expect(page.getByTestId('slice-machine-printer')).toContainText('H2D 0.4')
  await expect(page.getByTestId('slice-machine-printer')).not.toContainText('CHAINSAW')
  // After the slice, the summary's Export names the printer the same way, inside its button.
  const exportBtn = page.getByTestId('slice-summary').getByRole('button', { name: /^Export for H2D 0\.4/ })
  await expect(exportBtn).toBeVisible({ timeout: 120_000 })
  expect(await inside('[data-testid="slice-summary"] .btn-name')).toEqual({ oneLine: true, fits: true })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})

test('on a phone, the plate chip names the plate only, whatever the object is called', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone width')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await expect(page.getByTestId('plate-chip')).toBeVisible({ timeout: 120_000 })
  // The starter is on the plate before its name changes.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length), { timeout: 120_000 }).toBeGreaterThan(0)
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): { plate: { name: string }[] }; setState(p: unknown): void } }).__sx
    const [o, ...rest] = sx.getState().plate
    sx.setState({ plate: [{ ...o, name: `${'Very_long_model_name_from_a_marketplace_download_'.repeat(2)}v2.stl` }, ...rest] })
  })
  await expect(page.getByTestId('plate-chip')).toHaveText('Plate 1')
  await expect.poll(() => page.getByTestId('plate-chip').evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true)
})
