// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament rail in the Slice sidebar: hovering a slot picks its filament out in the viewport, Alt-click selects
// the objects on it, a slot that differs from the printer's carries a dot and a way back, the rail scrolls inside the
// card when it overflows, and it fits a phone. Under the rail, every mode says what a click does and offers Add filament,
// or, when the printer fills the slots in, says why there is no add and how to change one.
import { type Page } from '@playwright/test'
import { expect, openSheet, plateReady, test } from './fixtures'

type Sx = { getState(): { selectedIds: string[]; plate: { id: string }[]; hoverSlot: number | null }; setState(p: unknown): void }
const sx = (page: Page, p: unknown) => page.evaluate((x) => (window as unknown as { __sx: Sx }).__sx.setState(x), p)

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((p) => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', printerId: 'bay-1', pilot: { mode: 'off' }, ...p }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
  // On a phone the sidebar is a sheet.
  await openSheet(page)
  await expect(page.getByTestId('slice-filament-rail')).toBeVisible()
}

const slot = (page: Page, n: number) => page.locator(`[data-testid="slice-filament-slot"][data-slot="${n}"]`)

test('hovering or focusing a slot picks its filament out in the viewport, and leaving clears it', async ({ page, isMobile }) => {
  await open(page)
  const host = page.locator('.vp-stage')
  await expect(host).not.toHaveAttribute('data-highlight', /./)
  if (!isMobile) {
    await slot(page, 2).hover()
    await expect(host).toHaveAttribute('data-highlight', '2')
    await expect(page.getByTestId('slice-filament-slot-line')).toContainText(/^PLA /)
    await page.mouse.move(700, 450)
    await expect(host).not.toHaveAttribute('data-highlight', /./)
  }
  await slot(page, 1).focus()
  await expect(host).toHaveAttribute('data-highlight', '1')
  await slot(page, 1).blur()
  await expect(host).not.toHaveAttribute('data-highlight', /./)
})

test('Alt-click selects every object on that filament and says so', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Alt needs a keyboard')
  await open(page)
  await sx(page, { selection: null, selectedIds: [] })
  await slot(page, 1).click({ modifiers: ['Alt'] })
  await expect(page.getByTestId('toast').filter({ hasText: /^Selected 1 object on PLA / })).toBeVisible()
  const picked = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().selectedIds)
  expect(picked).toHaveLength(1)
  // A plain click edits the slot.
  await slot(page, 1).click()
  await expect(page.getByRole('dialog', { name: /Filament 1/ })).toBeVisible()
})

test('a slot set to another filament than the printer holds shows a dot, says why, and goes back to the printer', async ({ page }) => {
  await open(page)
  await sx(page, { slotSetup: { 1: { type: 'PETG', brand: '', color: '#ffffff' } } })
  await expect(slot(page, 1)).toHaveAttribute('data-mismatch', 'true')
  await expect(slot(page, 1)).toHaveAttribute('data-tip-body', /^The printer has \w+ \w+ in slot 1\. The project uses PETG White\.$/)
  await slot(page, 1).focus()
  const fix = page.getByTestId('slice-filament-slot-line').getByTestId('slice-filament-use-printer')
  await expect(fix).toHaveText("Use printer's filament")
  await fix.click()
  await expect(slot(page, 1)).not.toHaveAttribute('data-mismatch', 'true')
})

test('the context menu offers the printer filament, by mouse and by keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Context menu by mouse and keys')
  await open(page)
  await sx(page, { slotSetup: { 2: { type: 'PETG', brand: '', color: '#ffffff' } } })
  await slot(page, 2).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Filament slot' })
  await expect(menu.getByTestId('slice-filament-use-printer')).toBeVisible()
  await page.keyboard.press('Escape')
  await slot(page, 2).focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await menu.getByTestId('slice-filament-use-printer').click()
  await expect(slot(page, 2)).not.toHaveAttribute('data-mismatch', 'true')
})

test('the menu holds Calibrate, Flush volumes, Swap colors, Reset to printer and Show unused slots', async ({ page }) => {
  await open(page)
  const all = await page.getByTestId('slice-filament-slot').count()
  await page.getByTestId('slice-filament-menu').click()
  await expect(page.getByTestId('slice-filament-calibrate')).toBeVisible()
  await expect(page.getByTestId('slice-filament-flush')).toBeVisible()
  await expect(page.getByTestId('slice-filament-swap')).toBeVisible()
  // Nothing edited: no reset.
  await expect(page.getByTestId('slice-filament-reset')).toHaveCount(0)
  await page.getByRole('menuitemcheckbox', { name: 'Show unused slots' }).click()
  await expect.poll(() => page.getByTestId('slice-filament-slot').count()).toBeGreaterThan(all)
  await expect(page.locator('[data-testid="slice-filament-slot"][data-used="false"]').first()).toBeVisible()
})

test('Swap colors opens from the menu and swaps the two filaments on the plate', async ({ page }) => {
  await open(page)
  await page.getByTestId('slice-filament-menu').click()
  await page.getByTestId('slice-filament-swap').click()
  const swap = page.getByRole('group', { name: 'Swap colors on this plate' })
  await expect(swap).toBeVisible()
  await swap.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(swap).toContainText('prints as')
  await swap.getByRole('button', { name: 'Undo swaps' }).click()
  await expect(swap).not.toContainText('prints as')
})

test('a full rail scrolls inside the card, never the page, at any width', async ({ page }) => {
  await open(page, { printerId: null })
  const setup = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, { type: 'PLA', brand: '', color: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][i % 4] }]))
  await sx(page, { slotSetup: setup, showUnusedSlots: true })
  await expect(page.getByTestId('slice-filament-slot')).toHaveCount(16)
  const rail = page.getByTestId('slice-filament-rail')
  const box = await rail.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  expect(box.scroll).toBeGreaterThan(box.client)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  // The last ring is reached by scrolling the rail.
  await slot(page, 16).scrollIntoViewIfNeeded()
  await expect(slot(page, 16)).toBeInViewport()
})

const foot = (page: Page) => page.getByTestId('slice-filament-foot')

/** The drying note takes the hint's line once the settings plan loads, at the same height; It's dry gives the line back. */
async function answerDryNote(page: Page): Promise<void> {
  const note = foot(page).getByRole('status', { name: 'Setup notes' })
  await expect(note).toContainText(/^Dry PLA/, { timeout: 15_000 })
  const height = (await foot(page).boundingBox())!.height
  await note.getByRole('button', { name: "It's dry" }).click()
  await expect(note).toHaveCount(0)
  expect((await foot(page).boundingBox())!.height).toBe(height)
}
/** A printer added by hand with no connection: it reports no slots, so the project's filaments are all set here. */
const UNCONNECTED = { handPrinters: [{ id: 'e2e-desk-a1', name: 'Desk A1', profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }], printerId: 'e2e-desk-a1' }

for (const settingsMode of ['simple', 'expert'] as const) {
  test(`Add filament shows in ${settingsMode === 'simple' ? 'Simple' : 'Expert'}, opens the new filament, and moves nothing`, async ({ page }) => {
    await open(page, { ...UNCONNECTED, settingsMode })
    await answerDryNote(page)
    await expect(foot(page)).toContainText('Click a filament to change it.')
    const add = page.getByTestId('slice-filament-add')
    await expect(add).toHaveText('Add filament')
    const count = await page.getByTestId('slice-filament-slot').count()
    const before = { add: await add.boundingBox(), first: await slot(page, 1).boundingBox() }
    await add.click()
    // The new filament opens, so its material and color are picked right away.
    const dialog = page.getByRole('dialog', { name: `Filament ${count + 1}` })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Done' }).click()
    // It shows on the rail before anything prints with it, and nothing above or beside the button moved.
    await expect(page.getByTestId('slice-filament-slot')).toHaveCount(count + 1)
    await expect(slot(page, count + 1)).toBeVisible()
    expect(await add.boundingBox()).toEqual(before.add)
    expect(await slot(page, 1).boundingBox()).toEqual(before.first)
  })
}

test("with the printer's slots, the rail says where they come from, has no add, and resets to the printer", async ({ page }) => {
  await open(page)
  await expect(foot(page)).toHaveAttribute('data-from', 'printer')
  await answerDryNote(page)
  await expect(foot(page)).toContainText(/^From the printer('s \w+)?\. Click a slot to change it\.$/)
  await expect(page.getByTestId('slice-filament-add')).toHaveCount(0)
  await expect(page.getByTestId('slice-filament-foot-reset')).toHaveCount(0)
  // A slot changed here offers the way back, in place.
  await sx(page, { slotSetup: { 1: { type: 'PETG', brand: '', color: '#ffffff' } } })
  const reset = page.getByTestId('slice-filament-foot-reset')
  await expect(reset).toHaveText('Reset to printer')
  await reset.click()
  await expect(slot(page, 1)).not.toHaveAttribute('data-mismatch', 'true')
  await expect(reset).toHaveCount(0)
})

// Screenshots of the rail for review, Simple and Expert with no printer and with the printer's slots, light and dark:
// SX_SHOTS=1, saved to SX_SHOTS_DIR.
// Dark gray on the dark theme, white on the light one: colors close to the panel get a contrast edge, others do not.
const NEAR = { 1: { type: 'PLA', brand: '', color: '#282a36' }, 2: { type: 'PLA', brand: '', color: '#f8f8f2' }, 3: { type: 'PLA', brand: '', color: '#ff5555' }, 4: { type: 'PLA', brand: '', color: '#1a1a1a' } }
const edged = (page: Page, n: number) => slot(page, n).locator('.sx-swatch-ring')

test('a filament color close to the panel gets a contrast edge, in both themes', async ({ page }) => {
  await open(page, { ...UNCONNECTED })
  await sx(page, { slotSetup: NEAR, showUnusedSlots: true, scheme: 'dark', themeFollowsSystem: false })
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', /dark/)
  await expect(edged(page, 1)).toHaveAttribute('data-edge', 'true')
  await expect(edged(page, 4)).toHaveAttribute('data-edge', 'true')
  await expect(edged(page, 2)).not.toHaveAttribute('data-edge', /./)
  await expect(edged(page, 3)).not.toHaveAttribute('data-edge', /./)
  await sx(page, { scheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', /light/)
  await expect(edged(page, 2)).toHaveAttribute('data-edge', 'true')
  await expect(edged(page, 1)).not.toHaveAttribute('data-edge', /./)
  await expect(edged(page, 3)).not.toHaveAttribute('data-edge', /./)
})

test('shots: colors close to the panel, with their edge, light and dark', async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await open(page, { ...UNCONNECTED })
  const block = page.locator('[data-section="filament"]')
  for (const scheme of ['dark', 'light'] as const) {
    await sx(page, { slotSetup: NEAR, showUnusedSlots: true, scheme, themeFollowsSystem: false, hoverSlot: null })
    await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
    await block.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)
    await block.screenshot({ path: `${dir}/rail-near-panel-${scheme}-${width}.png` })
  }
})

const shotCases = [
  { name: 'simple-no-printer', prefs: { ...UNCONNECTED, settingsMode: 'simple' } },
  { name: 'expert-no-printer', prefs: { ...UNCONNECTED, settingsMode: 'expert' } },
  { name: 'printer-slots', prefs: { settingsMode: 'simple' } },
]
for (const c of shotCases) {
  test(`shots: the line under the rail, ${c.name}, light and dark`, async ({ page }, info) => {
    test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
    const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
    const width = page.viewportSize()?.width ?? 0
    await open(page, c.prefs)
    const block = page.locator('[data-section="filament"]')
    for (const scheme of ['dark', 'light'] as const) {
      await sx(page, { scheme, themeFollowsSystem: false, hoverSlot: null })
      await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
      await block.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.mouse.move(0, 0)
      await page.waitForTimeout(500)
      await block.screenshot({ path: `${dir}/rail-${c.name}-${scheme}-${width}.png` })
      await page.screenshot({ path: `${dir}/page-${c.name}-${scheme}-${width}.png` })
    }
  })
}

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: the rail, a slot picked out in the view, its menu and a mismatch, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await open(page)
  const rail = page.getByTestId('slice-filament-rail')
  for (const scheme of ['light', 'dark'] as const) {
    await sx(page, { scheme, themeFollowsSystem: false, slotSetup: {}, hoverSlot: null })
    await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
    await rail.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${dir}/rail-${scheme}-${width}.png` })
    if (!isMobile) await slot(page, 2).hover()
    else await slot(page, 2).focus()
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${dir}/rail-highlight-${scheme}-${width}.png` })
    await page.mouse.move(0, 0)
    await page.getByTestId('slice-filament-menu').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/rail-menu-${scheme}-${width}.png` })
    await page.keyboard.press('Escape')
    await sx(page, { slotSetup: { 1: { type: 'PETG', brand: '', color: '#ffffff' } } })
    await slot(page, 1).focus()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/rail-mismatch-${scheme}-${width}.png` })
    await slot(page, 1).blur()
  }
})
