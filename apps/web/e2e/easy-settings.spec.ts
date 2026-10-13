// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Goal tiles in Simple mode: each tile says what it gives on the printer in use, the picked tile's tooltip says
// about how long and how much from the last slice, and moving a control the goal sets marks its tile edited. Auto slice stays on
// here (the plain Playwright test, as in auto-slice.spec.ts), so a pick slices again on its own.
import { expect, test, type Page } from '@playwright/test'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'
import { openSheet, plateReady } from './fixtures'
import { projectZip } from './project-zip'

type Sx = { getState(): { slice: { status: string; stale?: boolean; result?: { id: string } } }; setState(p: unknown): void }

const TIERS = ['draft', 'standard', 'fine', 'strong'] as const

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((extra) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    // Auto slice on Always: picking a goal slices again in the background, which Auto would hold on a slow runner.
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', goal: 'standard', pilot: { mode: 'off' }, autoSliceBySize: false, ...extra }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
}

// The picked tile carries the estimate in its tooltip.
const estimate = (page: Page) => page.getByRole('radiogroup', { name: 'Goal' }).getByRole('radio', { checked: true })
const subtitles = (page: Page) => Promise.all(TIERS.map((t) => page.getByTestId(`slice-goal-${t}`).locator('.goal-sub').textContent()))

async function sliced(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale }), { timeout: 120_000 }).toBe(true)
}

test('picking Fine slices again and the picked tile\'s estimate changes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await sliced(page)
  await expect(estimate(page)).toHaveAttribute('data-tip-body', /^About \d/)
  const before = await estimate(page).getAttribute('data-tip-body')
  const firstId = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.result?.id)
  await page.getByTestId('slice-goal-fine').click()
  await expect(page.getByTestId('slice-goal-fine')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('slice-goal-fine').locator('.goal-sub')).toHaveText(/^0\.\d\d mm$/)
  // A new slice lands (a new id), and the line reads it.
  await expect.poll(() => page.evaluate((first) => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale && s.result?.id !== first }, firstId), { timeout: 120_000 }).toBe(true)
  await expect(estimate(page)).toHaveAttribute('data-tip-body', /^About \d/)
  expect(await estimate(page).getAttribute('data-tip-body')).not.toBe(before)
})

test('a 0.6 mm nozzle shows its own numbers on the tiles', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page, { autoSlice: false })
  await expect(page.getByTestId('slice-goal-draft').locator('.goal-sub')).toHaveText(/^0\.\d\d mm$/)
  const four = await subtitles(page)
  for (const line of four) expect(line).toMatch(/^(\d\.\d\d mm|\d+ walls)$/)
  await page.getByTestId('slice-machine-nozzle').click()
  await page.getByRole('radiogroup', { name: 'Nozzle size' }).getByRole('radio', { name: '0.6 mm' }).click()
  await expect.poll(() => subtitles(page), { timeout: 30_000 }).not.toEqual(four)
  for (const line of await subtitles(page)) expect(line).toMatch(/^(\d\.\d\d mm|\d+ walls)$/)
})

test('moving the layer height keeps Standard picked, marked edited, and pressing it goes back', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await open(page, { autoSlice: false })
  const goal = page.getByRole('radiogroup', { name: 'Goal' })
  const standard = page.getByTestId('slice-goal-standard')
  await expect(goal.getByRole('radio', { checked: true })).toHaveCount(1)
  await expect(page.locator('.goal-custom')).toHaveCount(0)
  // No slice yet: no estimate on the picked tile.
  await expect(estimate(page)).not.toHaveAttribute('data-tip-body')
  const box = await goal.boundingBox()
  await page.locator('#easy-layer').click()
  await page.getByRole('menuitemcheckbox', { name: '0.16 mm' }).click()
  await expect(page.locator('.goal-custom')).toHaveText('Edited')
  await expect(standard).toHaveAttribute('aria-checked', 'true')
  await expect(standard.locator('.goal-edited-dot')).toBeVisible()
  await expect(standard).toHaveAttribute('data-tip-rows', /^\[\["Layer height","0\.16 mm","\(0\.\d+\)"\]/)
  await expect(standard).toHaveAttribute('data-tip-body', 'Press Standard to go back to its settings.')
  // The mark moves nothing.
  expect(await goal.boundingBox()).toEqual(box)
  await standard.click()
  await expect(page.locator('.goal-custom')).toHaveCount(0)
  await expect(standard.locator('.goal-edited-dot')).toHaveCount(0)
  await expect(page.locator('#easy-layer')).not.toHaveText('0.16 mm')
  // Another goal starts over from it.
  await page.locator('#easy-layer').click()
  await page.getByRole('menuitemcheckbox', { name: '0.16 mm' }).click()
  await page.getByTestId('slice-goal-draft').click()
  await expect(page.locator('.goal-custom')).toHaveCount(0)
  await expect(page.getByTestId('slice-goal-draft')).toHaveAttribute('aria-checked', 'true')
})

test('a project that matches no goal opens on the nearest goal, marked edited', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  interceptFileDialogs(page)
  await open(page, { autoSlice: false })
  const P1S = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', printer_variant: '0.4', nozzle_diameter: ['0.4'], layer_height: '0.14', different_settings_to_system: ['layer_height', '', ''] }
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles({ name: 'odd-layers.3mf', mimeType: 'model/3mf', buffer: projectZip(P1S, {}, [118, 118]) })
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
  const fine = page.getByTestId('slice-goal-fine')
  await expect(fine).toHaveAttribute('aria-checked', 'true')
  await expect(fine.locator('.goal-edited-dot')).toBeVisible()
  await expect(page.locator('.goal-custom')).toHaveAttribute('data-tip-rows', /^\[\["Layer height","0\.14 mm",/)
})

// Screenshots of the tiles for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: fresh estimate, Updating, edited and no slice, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  const sx = (patch: unknown) => page.evaluate((p) => (window as unknown as { __sx: Sx }).__sx.setState(p), patch)
  // Centered, not just scrolled into view: the sticky Estimate footer covers the bottom of the sidebar.
  const center = () => page.getByRole('radiogroup', { name: 'Goal' }).evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const shoot = async (name: string) => {
    await center()
    // Let a tooltip or transition settle so the shot shows the state, not the change.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/goal-tiles-${name}-${width}.png` })
  }
  await open(page)
  await sliced(page)
  // on a phone the tiles are in the settings sheet
  if (isMobile) await openSheet(page)
  for (const scheme of ['light', 'dark'] as const) {
    await sx({ scheme, themeFollowsSystem: false, autoSlice: false })
    await sx({ goal: 'standard', easyTouched: [] })
    await page.waitForTimeout(300)
    const s = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice)
    await sx({ slice: { ...s, stale: false } })
    await expect(estimate(page)).toHaveAttribute('data-tip-body', /^About \d/)
    await shoot(`fresh-${scheme}`)
    await sx({ slice: { ...s, stale: true } })
    await expect(estimate(page)).toHaveAttribute('data-tip-body', 'Updating the estimate.')
    await shoot(`updating-${scheme}`)
    await sx({ goal: 'custom', slice: { ...s, stale: false } })
    await center()
    await sx({ easy: { detail: 55, strength: 20, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: false } })
    await expect(page.locator('.goal-custom')).toBeVisible()
    // On a phone there is no hover: the shot shows the mark and the chip
    if (!isMobile) await page.locator('.goal-custom').hover()
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${dir}/goal-tiles-edited-${scheme}-${width}.png` })
    await sx({ goal: 'standard', easy: { detail: 40, strength: 20, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true }, slice: { status: 'idle' } })
    await expect(estimate(page)).not.toHaveAttribute('data-tip-body')
    await shoot(`no-slice-${scheme}`)
    await sx({ slice: { ...s, stale: false } })
  }
})

test.describe('shots at 2x', () => {
  test.use({ deviceScaleFactor: 2 })
  test('shots: the four tiles close up, light and dark', async ({ page, isMobile }, info) => {
    test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
    test.skip(isMobile, 'Desktop width')
    const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
    await open(page, { autoSlice: false })
    const tiles = page.getByRole('radiogroup', { name: 'Goal' })
    for (const scheme of ['light', 'dark'] as const) {
      await page.evaluate((s) => (window as unknown as { __sx: Sx }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await tiles.screenshot({ path: `${dir}/icons-crop-${scheme}-1440@2x.png` })
    }
  })
})
