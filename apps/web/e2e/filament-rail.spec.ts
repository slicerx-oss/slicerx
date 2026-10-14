// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Filament section's spools in the Slice sidebar: every loaded spool shows, the ones in use have an edge and a part
// count, a click moves the selection (or the plate, or the parts on one filament) to that spool without moving
// anything on screen, hovering a spool picks its filament out in the viewport, Alt-click selects the objects on it, a
// slot that differs from the printer's carries a dot and a way back, and a full section wraps inside the card. Under
// the spools, every mode says how to change a filament and offers Add filament, or, when the printer fills the slots
// in, says where they come from.
import { type Page } from '@playwright/test'
import { expect, openSheet, plateReady, test } from './fixtures'

type Sx = { getState(): { selectedIds: string[]; plate: { id: string; slotOverrides?: Record<string, number>; handle: { parts: { name: string; slot: number }[] } }[]; hoverSlot: number | null; printerSlots: { material?: string; color?: string }[] }; setState(p: unknown): void }
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
  // A plain click moves the selection to that spool; the slot's menu edits what it holds.
  await slot(page, 1).click({ button: 'right' })
  await page.getByTestId('slice-filament-edit').click()
  await expect(page.getByRole('dialog', { name: /Filament 1/ })).toBeVisible()
})

/** The slot each part of each object prints in, as the plate holds it. */
const partSlots = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((e) => e.handle.parts.map((p) => e.slotOverrides?.[p.name] ?? p.slot)))
/** A loaded spool nothing on the plate prints with. */
async function freeSpool(page: Page): Promise<number> {
  const n = await page.locator('[data-testid="slice-filament-slot"][data-parts="0"]:not([data-empty])').first().getAttribute('data-slot')
  return Number(n)
}

test('every loaded spool shows; the ones in use carry an edge and a part count', async ({ page }) => {
  await open(page)
  const loaded = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().printerSlots.length)
  expect(loaded).toBeGreaterThan(1)
  await expect(page.getByTestId('slice-filament-slot')).toHaveCount(loaded)
  const used = page.locator('[data-testid="slice-filament-slot"]:not([data-parts="0"])').first()
  await expect(used.locator('.spool-count')).toHaveText(/^\d+$/)
  const edge = await used.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(edge).toMatch(/inset/)
  const idle = page.locator('[data-testid="slice-filament-slot"][data-parts="0"]').first()
  expect(await idle.evaluate((el) => getComputedStyle(el).boxShadow)).not.toMatch(/inset/)
  // in use and not in use keep one size
  const [a, b] = [await used.boundingBox(), await idle.boundingBox()]
  expect(a!.width).toBeCloseTo(b!.width, 1)
  expect(a!.height).toBeCloseTo(b!.height, 1)
})

test('a click moves the plate to that spool, says so, and moves nothing on screen', async ({ page }) => {
  await open(page)
  // every part on filament 1 and nothing selected: one filament in use, so the click moves the whole plate
  await page.evaluate(() => {
    const w = window as unknown as { __sx: Sx }
    w.__sx.setState({ selection: null, selectedIds: [], plate: w.__sx.getState().plate.map((e) => ({ ...e, slotOverrides: Object.fromEntries(e.handle.parts.map((p) => [p.name, 1])) })) })
  })
  await expect(page.getByTestId('slice-filament-target')).toHaveAttribute('data-kind', 'plate')
  const to = await freeSpool(page)
  const boxes = async () => page.locator('[data-section="filament"] .slot-rail-wrap, [data-testid="slice-filament-slot"], [data-testid="slice-filament-target"], [data-testid="slice-filament-slot-line"], [data-testid="slice-filament-note"], [data-testid="slice-filament-foot"]').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 2) / 2) }))
  const at = await boxes()
  await slot(page, to).click()
  await expect(slot(page, to)).toHaveAttribute('aria-pressed', 'true')
  await expect(slot(page, to)).not.toHaveAttribute('data-parts', '0')
  expect((await partSlots(page)).flat().every((n) => n === to)).toBe(true)
  await expect(page.getByTestId('slice-filament-note')).toHaveText(/^You picked \w+\.$|on a \w+ profile: the slice uses/)
  expect(await boxes()).toEqual(at)
})

test('with something selected, a click moves only the selection', async ({ page }) => {
  await open(page)
  const id = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.id)
  await sx(page, { selection: id, selectedIds: [id] })
  await expect(page.getByTestId('slice-filament-target')).toHaveAttribute('data-kind', 'objects')
  const to = await freeSpool(page)
  await slot(page, to).click()
  expect((await partSlots(page))[0]!.every((n) => n === to)).toBe(true)
})

test('with two filaments in use and nothing selected, the row under the spools picks which one moves', async ({ page }) => {
  await open(page)
  const id = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.id)
  const parts = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.handle.parts.map((p) => p.name))
  test.skip(parts.length < 2, 'needs an object of two parts')
  // the second part on another spool: two filaments in use
  await sx(page, { selection: null, selectedIds: [] })
  const first = (await partSlots(page))[0]![0]!
  const other = await freeSpool(page)
  await page.evaluate(([oid, part, n]) => {
    const w = window as unknown as { __sx: Sx & { getState(): { plate: unknown[] } } }
    const plate = w.__sx.getState().plate as { id: string; slotOverrides?: Record<string, number> }[]
    w.__sx.setState({ plate: plate.map((e) => (e.id === oid ? { ...e, slotOverrides: { ...e.slotOverrides, [part as string]: n } } : e)) })
  }, [id, parts[1]!, other] as const)
  await expect(page.getByTestId('slice-filament-target')).toHaveAttribute('data-kind', 'filament')
  const pick = page.getByTestId(`slice-filament-target-${other}`)
  await expect(pick).toHaveAttribute('aria-checked', 'false')
  const at = await pick.boundingBox()
  await pick.click()
  await expect(pick).toHaveAttribute('aria-checked', 'true')
  expect(await pick.boundingBox()).toEqual(at)
  const third = Number(await page.locator('[data-testid="slice-filament-slot"][data-parts="0"]:not([data-empty])').first().getAttribute('data-slot'))
  await slot(page, third).click()
  const now = (await partSlots(page))[0]!
  expect(now[1]).toBe(third)
  expect(now.filter((n) => n === first).length).toBeGreaterThan(0)
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

test('the menu holds Calibrate, Flush volumes, Swap colors and Reset to printer', async ({ page }) => {
  await open(page)
  await page.getByTestId('slice-filament-menu').click()
  await expect(page.getByTestId('slice-filament-calibrate')).toBeVisible()
  await expect(page.getByTestId('slice-filament-flush')).toBeVisible()
  await expect(page.getByTestId('slice-filament-swap')).toBeVisible()
  // Nothing edited: no reset. Every spool shows already, so there is no switch for unused ones.
  await expect(page.getByTestId('slice-filament-reset')).toHaveCount(0)
  await expect(page.getByRole('menuitemcheckbox', { name: 'Show unused slots' })).toHaveCount(0)
  await expect(page.locator('[data-testid="slice-filament-slot"][data-used="false"]').first()).toBeVisible()
})

test('the Filament options menu sits on top of the nozzle rows under it', async ({ page, isMobile }) => {
  // A folding Filament card (advanced settings) on a two-nozzle hotend rack printer whose AMS has not reported yet: the
  // rail is short, so the menu hangs over the nozzle switch and the hotend rack buttons.
  await open(page, { printerId: 'bay-6', settingsMode: 'advanced' })
  await sx(page, { printerSlots: [], slotSetup: {} })
  const racks = page.locator('.nozzle-row select')
  await expect(racks).toHaveCount(2)
  await page.locator('[data-section="filament"]').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.getByTestId('slice-filament-menu').click()
  const menu = page.getByRole('menu', { name: 'Filament options' })
  await expect(menu.getByTestId('slice-filament-calibrate')).toBeFocused()
  const hits = await menu.evaluate((m) => {
    const r = m.getBoundingClientRect()
    const inside = (x: number, y: number) => x > r.left + 2 && x < r.right - 2 && y > r.top + 2 && y < r.bottom - 2
    // every point of the menu, its padding included, belongs to the menu
    let missed = 0
    for (let x = r.left + 3; x < r.right - 3; x += 8) for (let y = r.top + 3; y < r.bottom - 3; y += 8) if (!m.contains(document.elementFromPoint(x, y))) missed++
    // and where a rack button or the nozzle switch lies under it, a point there hits the menu
    const under = Array.from(document.querySelectorAll('.nozzle-row select, .nozzle-map .sx-switch')).flatMap((el) => {
      const b = el.getBoundingClientRect()
      const x = Math.min(b.right - 4, r.right - 6)
      const y = Math.min(b.top + 4, r.bottom - 6)
      return inside(x, y) && x > b.left && y < b.bottom ? [m.contains(document.elementFromPoint(x, y))] : []
    })
    return { missed, under }
  })
  expect(hits.missed).toBe(0)
  // the short rail puts something under the menu at both widths, so the check above is not empty
  if (!isMobile) expect(hits.under.length).toBeGreaterThan(0)
  expect(hits.under.every(Boolean)).toBe(true)
  // the menu still works where it overlaps a rack button: the click lands on the menu, not the rack under it
  const rack = await racks.first().inputValue()
  await menu.getByTestId('slice-filament-calibrate').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { calibrationOpen: boolean } } }).__sx.getState().calibrationOpen)).toBe(true)
  expect(await racks.first().inputValue()).toBe(rack)
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

test('a full section wraps inside the card, never the page, at any width', async ({ page }) => {
  await open(page, { printerId: null })
  const setup = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, { type: 'PLA', brand: '', color: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][i % 4] }]))
  await sx(page, { slotSetup: setup })
  await expect(page.getByTestId('slice-filament-slot')).toHaveCount(16)
  const rail = page.getByTestId('slice-filament-rail')
  const box = await rail.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  expect(box.scroll).toBeLessThanOrEqual(box.client)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  // Four to a row: the fifth starts the second row under the first.
  const [one, five] = [await slot(page, 1).boundingBox(), await slot(page, 5).boundingBox()]
  expect(five!.x).toBeCloseTo(one!.x, 0)
  expect(five!.y).toBeGreaterThan(one!.y)
  await slot(page, 16).scrollIntoViewIfNeeded()
  await expect(slot(page, 16)).toBeInViewport()
})

const foot = (page: Page) => page.getByTestId('slice-filament-foot')

/** The line under the rail reads its hint, or a setup note in the hint's place once the settings plan has one. */
async function lineReads(page: Page, hint: RegExp): Promise<void> {
  await expect(async () => {
    const note = await foot(page).getByRole('status', { name: 'Setup notes' }).count()
    expect(note > 0 || hint.test(await foot(page).locator('.rail-foot-text').innerText())).toBe(true)
  }).toPass()
}
/** A printer added by hand with no connection: it reports no slots, so the project's filaments are all set here. */
const UNCONNECTED = { handPrinters: [{ id: 'e2e-desk-a1', name: 'Desk A1', profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }], printerId: 'e2e-desk-a1' }

for (const settingsMode of ['simple', 'expert'] as const) {
  test(`Add filament shows in ${settingsMode === 'simple' ? 'Simple' : 'Expert'}, opens the new filament, and moves nothing`, async ({ page }) => {
    await open(page, { ...UNCONNECTED, settingsMode })
    await lineReads(page, /^Right-click a filament to change it\.$/)
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
  await lineReads(page, /^From the printer('s \w+)?\. Right-click a spool to change it\.$/)
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

// Filament pick F1 for review at the two desktop sizes, light and dark: the section as it opens, then with a part on
// a second spool, so the edge and count show on two and the row under the spools picks which filament moves.
for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
  test(`shots: filament pick at ${size.width}x${size.height}, light and dark`, async ({ page, isMobile }, info) => {
    test.skip(!process.env['SX_SHOTS'] || isMobile, 'SX_SHOTS=1, desktop')
    const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
    await page.setViewportSize(size)
    await open(page)
    const block = page.locator('[data-section="filament"]')
    const shoot = async (name: string) => {
      for (const scheme of ['dark', 'light'] as const) {
        await sx(page, { scheme, themeFollowsSystem: false, hoverSlot: null })
        await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
        await block.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        await page.mouse.move(0, 0)
        await page.waitForTimeout(500)
        await block.screenshot({ path: `${dir}/f1-${name}-${scheme}-${size.width}.png` })
        await page.screenshot({ path: `${dir}/f1-page-${name}-${scheme}-${size.width}.png` })
      }
    }
    await sx(page, { selection: null, selectedIds: [] })
    await shoot('one')
    const parts = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.handle.parts.map((p) => p.name))
    const other = await freeSpool(page)
    const id = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.id)
    await page.evaluate(([oid, part, n]) => {
      const w = window as unknown as { __sx: Sx }
      const plate = w.__sx.getState().plate
      w.__sx.setState({ plate: plate.map((e) => (e.id === oid ? { ...e, slotOverrides: { ...e.slotOverrides, [part as string]: n } } : e)) })
    }, [id, parts[parts.length - 1]!, other] as const)
    await shoot('two')
  })
}
