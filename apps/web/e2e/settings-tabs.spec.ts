// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print settings in Advanced and Expert sit behind tabs, one per group. Color shows only with two or more filaments
// and holds the atlas prime tower row; a search looks through every tab; arrows move between tabs.
import { expect, openSheet, plateReady, test } from './fixtures'
import type { Page } from '@playwright/test'

type Sx = { getState(): { plate: { parts: { name: string }[] }[] }; setState(p: unknown): void }

async function open(page: Page, isMobile: boolean, mode = 'advanced'): Promise<void> {
  await page.addInitScript((mode) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: mode, pilot: { mode: 'off' } }))
  }, mode)
  await page.goto('./')
  await plateReady(page)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ expertOpen: true }))
  // On a phone the settings are in the sheet.
  if (isMobile) await openSheet(page)
}

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Setting groups' }).getByRole('tab')

test('one tab per group; Color shows with two filaments and holds the atlas row', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  await open(page, isMobile)
  // The demo X prints in two filaments.
  await expect.poll(() => tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['Quality', 'Strength', 'Speed', 'Supports', 'Adhesion', 'Color', 'Surface', 'Output and print order'])
  await expect(page.getByTestId('slice-settings-tab-quality')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#set-tab-panel .tier-group')).toHaveCount(1)
  await expect(page.getByTestId('slice-tower-atlas')).toHaveCount(0)
  await page.getByTestId('slice-settings-tab-multicolor').click()
  await expect(page.getByTestId('slice-settings-tab-multicolor')).toHaveAttribute('aria-selected', 'true')
  // One prime tower switch, first in the Color section under its heading, with atlas's placement under it.
  const color = page.locator('#set-tab-panel section[aria-label="Color"]')
  await expect(color.getByRole('switch', { name: /^Prime tower Wipes/ })).toHaveCount(1)
  // atlas places the tower: no second switch for automatic placement.
  await expect(page.getByRole('switch', { name: /automatically/i })).toHaveCount(0)
  await expect(color.locator('ul > li').first()).toHaveClass(/tower-row/)
  await expect(color.getByTestId('slice-tower-atlas')).toContainText('atlas places it')
  // The Filament card no longer has it.
  await expect(page.locator('[data-section="filament"] .tower-row')).toHaveCount(0)
})

test('with one filament there is no Color tab, and an open Color tab falls back to Quality', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  await open(page, isMobile)
  await page.getByTestId('slice-settings-tab-multicolor').click()
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    sx.setState({ plate: sx.getState().plate.map((e) => ({ ...e, slotOverrides: Object.fromEntries(e.parts.map((p) => [p.name, 1])) })) })
  })
  await expect(page.getByTestId('slice-settings-tab-multicolor')).toHaveCount(0)
  await expect(page.getByTestId('slice-settings-tab-quality')).toHaveAttribute('aria-selected', 'true')
})

test('arrows move between tabs, and a search looks through all of them', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  await open(page, isMobile)
  await page.getByTestId('slice-settings-tab-quality').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('slice-settings-tab-strength')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('slice-settings-tab-strength')).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByTestId('slice-settings-tab-output')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('slice-settings-tab-quality')).toHaveAttribute('aria-selected', 'true')
  // A search lists matches from every group, with no tab picked.
  await page.locator('#expert-search').fill('wall')
  await expect.poll(() => page.locator('#set-tab-panel .tier-group').count()).toBeGreaterThan(1)
  await expect(tabs(page).and(page.locator('[aria-selected="true"]'))).toHaveCount(0)
})

test('in Expert, print sequence heads Output, and a search finds it there', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  await open(page, isMobile, 'expert')
  await page.getByTestId('slice-settings-tab-output').click()
  const output = page.locator('#set-tab-panel section[aria-label="Output and print order"]')
  await expect(output.locator('ul > li').first().locator('#set-print_sequence')).toHaveCount(1)
  await page.locator('#expert-search').fill('print sequence')
  await expect(page.locator('#set-tab-panel section[aria-label="Output and print order"] #set-print_sequence')).toHaveCount(1)
  await expect(page.locator('#set-tab-panel section[aria-label="Surface"] #set-print_sequence')).toHaveCount(0)
})

test('on a phone the tabs are one row of 44 px targets that scrolls sideways, stays still and keeps the open tab in view', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  test.skip(!isMobile, 'Phone only')
  await open(page, isMobile, 'expert')
  const row = page.getByRole('tablist', { name: 'Setting groups' })
  const all = tabs(page)
  await expect(all.first()).toBeVisible()
  const n = await all.count()
  expect(n).toBeGreaterThan(6)
  const boxes = await Promise.all(Array.from({ length: n }, (_, i) => all.nth(i).boundingBox()))
  // One row, never wrapped, every tab a finger can hit.
  expect(new Set(boxes.map((b) => Math.round(b!.y))).size).toBe(1)
  for (const b of boxes) {
    expect(b!.height).toBeGreaterThanOrEqual(44)
    expect(b!.width).toBeGreaterThanOrEqual(44)
  }
  const heading = page.locator('[data-section="expert"] .sx-block-h').first()
  for (let i = n - 1; i >= 0; i--) {
    // The click's own scroll (into view) is not the app moving anything: measure after it.
    await all.nth(i).scrollIntoViewIfNeeded()
    const before = (await heading.boundingBox())!.y
    const rowY = (await row.boundingBox())!.y
    await all.nth(i).click()
    await expect(all.nth(i)).toHaveAttribute('aria-selected', 'true')
    // Nothing above the row moves, nor the row itself.
    expect((await heading.boundingBox())!.y).toBe(before)
    expect((await row.boundingBox())!.y).toBe(rowY)
    // The open tab is inside the row's view.
    const r = (await row.boundingBox())!
    const t = (await all.nth(i).boundingBox())!
    expect(t.x).toBeGreaterThanOrEqual(r.x - 1)
    expect(t.x + t.width).toBeLessThanOrEqual(r.x + r.width + 1)
  }
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: the tabs in the phone sheet, Advanced and Expert, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'] || !isMobile, 'SX_SHOTS=1 on a phone only')
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  await open(page, isMobile, 'advanced')
  for (const scheme of ['light', 'dark'] as const) {
    for (const mode of ['advanced', 'expert'] as const) {
      await page.evaluate((p) => (window as unknown as { __sx: Sx }).__sx.setState(p), { scheme, themeFollowsSystem: false, settingsMode: mode, expertOpen: true })
      await page.getByRole('tablist', { name: 'Setting groups' }).evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${dir}/phone-tabs-${mode}-${scheme}.png` })
    }
  }
})

test('a setting changed in Expert stays listed after a switch to Advanced, under the Expert divider', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: the mode chip sits in the Slice pane title')
  await open(page, isMobile, 'expert')
  const quality = page.locator('#set-tab-panel section[aria-label="Quality"]')
  await quality.locator('.tier-more').click()
  const row = quality.locator('li', { has: page.locator('#set-detect_thin_wall') })
  await row.locator('#set-detect_thin_wall').click()
  await expect(row).toHaveClass(/changed/)
  await page.getByTestId('slice-mode-chip').click()
  await page.getByTestId('slice-mode-chip-advanced').click()
  await expect(page.getByTestId('slice-mode-chip')).toHaveText('Advanced')
  // Still there, after the Advanced rows and the divider; nothing else from Expert, and no "more" to open.
  await expect(row).toBeVisible()
  await expect(row).toHaveClass(/changed/)
  const items = quality.locator('ul > li')
  const order = await items.evaluateAll((els) => els.map((e) => (e.classList.contains('tier-divider') ? 'divider' : e.querySelector('#set-detect_thin_wall') ? 'changed' : 'row')))
  expect(order.filter((x) => x !== 'row')).toEqual(['divider', 'changed'])
  expect(order.at(-1)).toBe('changed')
  await expect(quality.locator('.tier-more')).toHaveCount(0)
  // An Expert setting left alone stays out of Advanced.
  await expect(page.locator('#set-precise_z_height')).toHaveCount(0)
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: a changed Expert setting in Advanced, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await open(page, isMobile, 'advanced')
  for (const scheme of ['light', 'dark'] as const) {
    await page.evaluate((p) => (window as unknown as { __sx: Sx }).__sx.setState(p), { scheme, themeFollowsSystem: false, settingsMode: 'advanced', expertOpen: true, settingsTab: 'quality', overrides: { detect_thin_wall: true } })
    // A phone has Simple settings only: its shot shows the sheet as it is.
    const last = page.locator('#set-tab-panel section[aria-label="Quality"] ul > li').last()
    if (!isMobile) await last.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/expert-in-advanced-${scheme}-${width}.png` })
  }
})
