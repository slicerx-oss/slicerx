// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Goal tiles in Simple mode: each tile says what it gives on the printer in use, the line under them says about
// how long and how much from the last slice, and moving a control the goal sets shows Custom. Auto slice stays on
// here (the plain Playwright test, as in auto-slice.spec.ts), so a pick slices again on its own.
import { expect, test, type Page } from '@playwright/test'
import { plateReady } from './fixtures'

type Sx = { getState(): { slice: { status: string; stale?: boolean; result?: { id: string } } }; setState(p: unknown): void }

const TIERS = ['draft', 'standard', 'fine', 'strong'] as const

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((extra) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', goal: 'standard', pilot: { mode: 'off' }, ...extra }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
}

const estimate = (page: Page) => page.getByTestId('slice-goal-estimate')
const subtitles = (page: Page) => Promise.all(TIERS.map((t) => page.getByTestId(`slice-goal-${t}`).locator('.goal-sub').textContent()))

async function sliced(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale }), { timeout: 120_000 }).toBe(true)
}

test('picking Fine slices again and the line under the tiles changes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await sliced(page)
  await expect(estimate(page)).toHaveText(/^About \d/)
  const before = await estimate(page).textContent()
  const firstId = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.result?.id)
  await page.getByTestId('slice-goal-fine').click()
  await expect(page.getByTestId('slice-goal-fine')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('slice-goal-fine').locator('.goal-sub')).toHaveText(/^0\.\d\d mm$/)
  // A new slice lands (a new id), and the line reads it.
  await expect.poll(() => page.evaluate((first) => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale && s.result?.id !== first }, firstId), { timeout: 120_000 }).toBe(true)
  await expect(estimate(page)).toHaveText(/^About \d/)
  expect(await estimate(page).textContent()).not.toBe(before)
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

test('moving the layer height shows Custom with no tile picked, and a goal starts over', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await open(page, { autoSlice: false })
  const goal = page.getByRole('radiogroup', { name: 'Goal' })
  await expect(goal.getByRole('radio', { checked: true })).toHaveCount(1)
  await expect(page.locator('.goal-custom')).toHaveCount(0)
  // No slice yet: no line under the tiles.
  await expect(estimate(page)).toHaveCount(0)
  await page.locator('#easy-layer').click()
  await page.getByRole('menuitemcheckbox', { name: '0.16 mm' }).click()
  await expect(page.locator('.goal-custom')).toHaveText('Custom')
  await expect(page.locator('.goal-custom')).toHaveAttribute('data-tip', 'You changed a setting the goal sets. Pick a goal to start over.')
  await expect(goal.getByRole('radio', { checked: true })).toHaveCount(0)
  await page.getByTestId('slice-goal-draft').click()
  await expect(page.locator('.goal-custom')).toHaveCount(0)
  await expect(page.getByTestId('slice-goal-draft')).toHaveAttribute('aria-checked', 'true')
})

// Screenshots of the tiles for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: fresh estimate, Updating, Custom and no slice, light and dark', async ({ page }, info) => {
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
  for (const scheme of ['light', 'dark'] as const) {
    await sx({ scheme, themeFollowsSystem: false, autoSlice: false })
    await sx({ goal: 'standard', easyTouched: [] })
    await page.waitForTimeout(300)
    const s = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice)
    await sx({ slice: { ...s, stale: false } })
    await expect(estimate(page)).toHaveText(/^About \d/)
    await shoot(`fresh-${scheme}`)
    await sx({ slice: { ...s, stale: true } })
    await expect(estimate(page)).toHaveText('Updating')
    await shoot(`updating-${scheme}`)
    await sx({ goal: 'custom', slice: { ...s, stale: false } })
    await center()
    await expect(page.locator('.goal-custom')).toBeVisible()
    await page.locator('.goal-custom').hover()
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${dir}/goal-tiles-custom-${scheme}-${width}.png` })
    await sx({ goal: 'standard', slice: { status: 'idle' } })
    await expect(estimate(page)).toHaveCount(0)
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
