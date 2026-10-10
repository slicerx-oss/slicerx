// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice's right pane never opens by itself: it starts shut, stays shut through a slice, and its edge tab glows when
// something in it wants a look, until the pane is opened. Long names stay on one line, cut in the middle.
import { type Page } from '@playwright/test'
import { expect, plateReady, sliceCount, sliced, test } from './fixtures'

/** The plate is in when its chip names the starter (plateReady looks in the objects list, which is shut here). */
const plateIn = (page: Page) => expect(page.locator('.platechip', { hasText: 'Layered X' })).toBeVisible({ timeout: 120_000 })

type Sx = { getState(): { slice: { status: string; result: { warnings: unknown[] } } }; setState(p: unknown): void }
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

  test('starts shut and stays shut through a clean slice, with no glow', async ({ page }) => {
    await open(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('slice-summary')).toHaveCount(0)
    await slice(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(tab(page)).not.toHaveAttribute('data-attention', /./)
  })

  test('glows for a slice with warnings until it is opened, and stays open after a reload', async ({ page }) => {
    await open(page)
    await slice(page)
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
    // The person's choice persists.
    await tab(page).click()
    await page.reload()
    await plateIn(page)
    await expect(tab(page)).toHaveAttribute('aria-expanded', 'true')
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

test('a 120-character file name stays on one line in the objects list, the plate chip and Print', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop width')
  const long = `${'Very_long_model_name_from_a_marketplace_download_'.repeat(2)}with_extras_v2_final.stl`.slice(-120)
  const printer = { id: 'e2e-long', name: 'H2D 0.4 from CHAINSAW_MAN_-_POCHITA_-_KEYCHAIN_WITH_A_VERY_LONG_PROJECT_NAME', profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }
  await page.addInitScript(() => sessionStorage.setItem('sx-right-pane', 'open'))
  await page.addInitScript((p) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, autoSlice: true, handPrinters: [p], printerId: p.id }))
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
      // Inside the control around it; a chip on the view, inside the view.
      const host = el.classList.contains('platechip') ? el.closest('.vp') : el.parentElement?.closest('button, .obj-row, .sx-block, aside')
      const parent = (host ?? el.parentElement!).getBoundingClientRect()
      return { oneLine: r.height < 40, fits: r.left >= parent.left - 0.5 && r.right <= parent.right + 0.5 }
    })
  for (const sel of ['[data-testid="object-name"]', '.platechip', '[data-testid="slice-machine-printer"] .printer-name']) {
    expect(await inside(sel), sel).toEqual({ oneLine: true, fits: true })
  }
  // The plate chip stays small, so the model size keeps its place beside it on the same row.
  const chips = await page.evaluate(() => {
    const a = document.querySelector('.platechip')!.getBoundingClientRect()
    const b = document.querySelector('.hud-bl .dims')!.getBoundingClientRect()
    return { narrow: a.width <= 320.5, sameRow: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 2 }
  })
  expect(chips).toEqual({ narrow: true, sameRow: true })
  // The export-only printer's footer action and the summary's Export name the printer without its project.
  await expect(page.getByTestId('slice-machine-printer')).toContainText('H2D 0.4')
  await expect(page.getByTestId('slice-machine-printer')).not.toContainText('CHAINSAW')
  // After the slice, the summary's Export names the printer the same way, inside its button.
  const exportBtn = page.getByTestId('slice-summary').getByRole('button', { name: /^Export for H2D 0\.4/ })
  await expect(exportBtn).toBeVisible({ timeout: 120_000 })
  expect(await inside('[data-testid="slice-summary"] .btn-name')).toEqual({ oneLine: true, fits: true })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})

test('on a phone, a long name gives way in the plate chip and the model size keeps the row', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone width')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await expect(page.locator('.hud-bl .dims')).toBeVisible({ timeout: 120_000 })
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): { plate: { name: string }[] }; setState(p: unknown): void } }).__sx
    const [o, ...rest] = sx.getState().plate
    sx.setState({ plate: [{ ...o, name: `${'Very_long_model_name_from_a_marketplace_download_'.repeat(2)}v2.stl` }, ...rest] })
  })
  const row = () =>
    page.evaluate(() => {
      const a = document.querySelector('.platechip')!.getBoundingClientRect()
      const b = document.querySelector('.hud-bl .dims')!.getBoundingClientRect()
      return { sameRow: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 2, inView: b.right <= innerWidth }
    })
  await expect.poll(row).toEqual({ sameRow: true, inView: true })
})
