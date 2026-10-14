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
  const walls = quality.locator('.set-sec[data-section="quality/walls"]')
  await walls.getByTestId('slice-settings-section').click()
  await walls.locator('.tier-more').click()
  const row = walls.locator('li', { has: page.locator('#set-detect_thin_wall') })
  await row.locator('#set-detect_thin_wall').click()
  await expect(row).toHaveClass(/changed/)
  await page.getByTestId('slice-mode-chip').click()
  await page.getByTestId('slice-mode-chip-advanced').click()
  await expect(page.getByTestId('slice-mode-chip')).toHaveText('Advanced')
  // Still there, after the Advanced rows and the divider; nothing else from Expert, and no "more" to open.
  await expect(row).toBeVisible()
  await expect(row).toHaveClass(/changed/)
  const items = walls.locator('ul > li')
  const order = await items.evaluateAll((els) => els.map((e) => (e.classList.contains('tier-divider') ? 'divider' : e.querySelector('#set-detect_thin_wall') ? 'changed' : 'row')))
  expect(order.filter((x) => x !== 'row')).toEqual(['divider', 'changed'])
  expect(order.at(-1)).toBe('changed')
  await expect(quality.locator('.tier-more')).toHaveCount(0)
  // Folded, the section still lists the change.
  await walls.getByTestId('slice-settings-section').click()
  await expect(walls.getByTestId('slice-settings-section')).toHaveAttribute('aria-expanded', 'false')
  await expect(row).toBeVisible()
  await expect(walls.locator('#set-wall_sequence')).toHaveCount(0)
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
    const last = page.locator('#set-tab-panel section[aria-label="Quality"] .set-sec[data-section="quality/walls"] li').last()
    if (!isMobile) await last.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/expert-in-advanced-${scheme}-${width}.png` })
  }
})

type Bridge = { getState(): { plate: { id: string; name: string }[]; settingsPins: string[]; settingsSections: Record<string, boolean> }; setState(p: unknown): void }
const header = (page: Page, key: string) => page.locator(`[data-testid="slice-settings-section"][data-section="${key}"]`)

test('sections fold to a summary line around the pointer, and changed rows stay listed', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  await open(page, isMobile)
  await page.evaluate(() => (window as unknown as { __sx: Bridge }).__sx.setState({ overrides: { seam_position: 'back' } }))
  // The first section with rows starts open; the others show a summary of their values.
  await expect(header(page, 'quality/layers')).toHaveAttribute('aria-expanded', 'true')
  const seam = header(page, 'quality/seam')
  await expect(seam).toHaveAttribute('aria-expanded', 'false')
  await expect(seam).toContainText('1 changed')
  await expect(page.locator('#set-seam_position')).toBeVisible()
  // Opening and closing never moves the header under the pointer.
  const walls = header(page, 'quality/walls')
  // The click's own scroll (into view) is not the app moving anything: measure after it.
  await walls.scrollIntoViewIfNeeded()
  const y = (await walls.boundingBox())!.y
  await walls.click()
  await expect(walls).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#set-wall_generator, [data-key="wall_generator"]').first()).toBeVisible()
  expect((await walls.boundingBox())!.y).toBe(y)
  await walls.click()
  await expect(walls).toHaveAttribute('aria-expanded', 'false')
  expect((await walls.boundingBox())!.y).toBe(y)
  // The tab counts its changes.
  await expect(page.getByTestId('slice-settings-tab-quality').getByTestId('slice-settings-tab-count')).toHaveText('1')
  await expect(page.getByTestId('slice-settings-tab-strength').getByTestId('slice-settings-tab-count')).toHaveCount(0)
})

test('the tab row sticks while its tab scrolls, a tab click never moves it, and a closing section near the end keeps its place', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  await open(page, isMobile, 'expert')
  // Open every Quality section, then scroll the pane far down so the tab row sticks.
  for (const key of ['layers', 'walls', 'seam', 'surfaces', 'overhangs', 'precision', 'flow']) {
    const h = header(page, `quality/${key}`)
    if ((await h.getAttribute('aria-expanded')) === 'false') await h.click()
  }
  const bar = page.locator('.set-tabs-bar')
  const last = header(page, 'quality/flow')
  await last.evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await page.mouse.wheel(0, 4000)
  await expect(bar).toHaveAttribute('data-stuck', 'true')
  const barY = (await bar.boundingBox())!.y
  // A closing section at the bottom of the pane keeps its header where it was.
  const flow = header(page, 'quality/flow')
  await flow.scrollIntoViewIfNeeded()
  const fy = (await flow.boundingBox())!.y
  await flow.click()
  await expect(flow).toHaveAttribute('aria-expanded', 'false')
  expect(Math.abs((await flow.boundingBox())!.y - fy)).toBeLessThanOrEqual(1)
  // A short tab under a stuck row: the row stays put and the tab shows from its start.
  await page.mouse.wheel(0, 4000)
  const stuckY = (await bar.boundingBox())!.y
  await page.getByTestId('slice-settings-tab-speed').click()
  await expect(page.getByTestId('slice-settings-tab-speed')).toHaveAttribute('aria-selected', 'true')
  expect(Math.abs((await bar.boundingBox())!.y - stuckY)).toBeLessThanOrEqual(1)
  const heading = page.locator('#set-tab-panel section[aria-label="Speed"] > h4')
  const hb = (await heading.boundingBox())!
  const bb = (await bar.boundingBox())!
  expect(hb.y).toBeGreaterThanOrEqual(bb.y + bb.height - 1)
  expect(hb.y).toBeLessThan(bb.y + bb.height + 40)
  expect(barY).toBeGreaterThanOrEqual(0)
})

test('pins, the open tab and sections come back after a reload; search finds a setting by what it fixes; Changed lists edits', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  await open(page, isMobile)
  await page.getByTestId('slice-settings-tab-supports').click()
  await header(page, 'supports/touch').click()
  const row = page.locator('#set-tab-panel li[data-key="support_top_z_distance"]')
  await row.hover()
  const pin = row.getByTestId('slice-setting-pin')
  await expect(pin).toBeVisible()
  const pinBox = (await pin.boundingBox())!
  const rowBox = (await row.boundingBox())!
  await pin.click()
  await expect(pin).toHaveAttribute('aria-pressed', 'true')
  // Pinning moves nothing in the row.
  expect((await row.boundingBox())!.x).toBe(rowBox.x)
  expect((await pin.boundingBox())!.x).toBe(pinBox.x)
  const pins = page.getByTestId('slice-settings-pins')
  await expect(pins.locator('#pin-support_top_z_distance')).toHaveCount(1)
  await page.reload()
  await plateReady(page)
  await page.evaluate(() => (window as unknown as { __sx: Bridge }).__sx.setState({ expertOpen: true }))
  await expect(page.getByTestId('slice-settings-tab-supports')).toHaveAttribute('aria-selected', 'true')
  await expect(header(page, 'supports/touch')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('slice-settings-pins').locator('#pin-support_top_z_distance')).toHaveCount(1)
  // A print problem finds the settings that help with it, Expert ones too, and says why.
  await page.locator('#expert-search').fill('stringing')
  const travel = page.locator('#set-tab-panel li[data-key="travel_speed"]')
  await expect(travel).toBeVisible()
  await expect(travel).toContainText('Helps with stringing')
  await page.locator('#expert-search').fill('')
  await expect(page.getByTestId('slice-settings-tab-supports')).toHaveAttribute('aria-selected', 'true')
  // Changed lists only edits, from every tab.
  await page.locator('#set-support_top_z_distance').first().fill('0.3')
  await page.locator('#set-support_top_z_distance').first().press('Enter')
  await page.getByTestId('slice-settings-changed').click()
  await expect(page.locator('#set-tab-panel li[data-testid="slice-setting-row"]')).toHaveCount(1)
  await page.getByTestId('slice-settings-changed').click()
  await expect(page.getByTestId('slice-settings-tab-supports')).toHaveAttribute('aria-selected', 'true')
})

test('a plate row shows the objects that print it with their own value, and a chip selects the object', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has Simple settings only, with no tabs')
  await open(page, isMobile)
  const obj = await page.evaluate(() => {
    const b = (window as unknown as { __sx: Bridge }).__sx
    const o = b.getState().plate[0]!
    b.setState({ objectSettings: { [o.id]: { top_shell_layers: 7 } }, settingsTab: 'strength' })
    return o
  })
  const chip = page.locator('li[data-key="top_shell_layers"]').getByTestId('slice-setting-object-chip')
  await expect(chip).toContainText(obj.name)
  await expect(chip).toContainText('7')
  await chip.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { selectedIds: string[] } } }).__sx.getState().selectedIds)).toEqual([obj.id])
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: settings layout A at 1440 and 1280, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'] || isMobile, 'SX_SHOTS=1 on desktop only')
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  await open(page, isMobile)
  const obj = await page.evaluate(() => (window as unknown as { __sx: Bridge }).__sx.getState().plate[0]!)
  // The pane scrolls the panel to its top, or a row to its middle, the way a person would.
  // The sidebar's own scroll only: scrollIntoView would also scroll the page around the app.
  const scrollPane = (sel: string, block: 'start' | 'center') =>
    page.locator(sel).first().evaluate((el, b) => {
      const pane = el.closest<HTMLElement>('.sx-rail-body')!
      pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - (b === 'center' ? pane.clientHeight / 2 : 0)
    }, block)
  for (const [w, h] of [[1440, 900], [1280, 800]] as const) {
    await page.setViewportSize({ width: w, height: h })
    for (const scheme of ['dark', 'light'] as const) {
      await page.evaluate(
        (p) => (window as unknown as { __sx: Bridge }).__sx.setState(p),
        { scheme, themeFollowsSystem: false, settingsMode: 'advanced', expertOpen: true, settingsTab: 'quality', settingsSections: {}, settingsPins: ['seam_position', 'brim_width'], overrides: { seam_position: 'back', elefant_foot_compensation: 0.2, top_shell_layers: 5 }, objectSettings: { [obj.id]: { top_shell_layers: 7 } }, selection: null, selectedIds: [], settingsScope: 'plate' },
      )
      await page.locator('#expert-search').fill('')
      await scrollPane('#expert-panel', 'start')
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${dir}/layout-a-quality-${scheme}-${w}.png` })
      // Strength with the object chip, scrolled so the tab row sticks.
      await page.getByTestId('slice-settings-tab-strength').click()
      await page.waitForTimeout(500)
      await scrollPane('#set-tab-panel li[data-key="top_shell_layers"]', 'center')
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${dir}/layout-a-strength-${scheme}-${w}.png` })
      await page.locator('#expert-search').fill('stringing')
      await scrollPane('#expert-panel', 'start')
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${dir}/layout-a-search-${scheme}-${w}.png` })
    }
  }
})
