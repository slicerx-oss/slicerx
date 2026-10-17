// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shared steps for the shell, sidebar and phone-shell journeys. Their tests share one page per worker, so every
// test starts from a known state with these instead of counting on a fresh boot: an emptied plate, the example plate,
// a mode, a slice. Nothing here sleeps; each step waits on the state it changes.
import { type Page } from '@playwright/test'
import { closeSheet, COLD_START_MS, expect, goTab, openSheet, sliceCount, sliced, tab } from '../../fixtures'
import { journey } from '../../journey'

export { expect }

/**
 * The journey page with the store hook (window.__sx, __vp) switched on. journey.ts sets `slicerx.debug` before every
 * load, so the hooks exist from the first frame; the reload below is only the guard for a page that lost them. The
 * prefs and the session flag are already stored, so that reload keeps them.
 */
export const test = journey.extend<object, { app: Page }>({
  app: [
    async ({ app }, use) => {
      if (!(await app.evaluate(() => Boolean((window as unknown as { __sx?: unknown }).__sx)))) {
        await app.evaluate(() => localStorage.setItem('slicerx.debug', '1'))
        await app.reload()
        await expect(app.locator('.obj-name', { hasText: 'Layered X' })).toBeVisible()
      }
      await use(app)
    },
    { scope: 'worker', timeout: COLD_START_MS + 120_000 },
  ],
})

type Sx = { setState(p: unknown): void }

/** Runs a command from Cmd+K by its title. The keys go again if the first press found the page not listening yet. */
export async function command(page: Page, title: string): Promise<void> {
  const palette = page.getByRole('dialog', { name: 'Commands' })
  await expect(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 20_000 })
  await page.keyboard.type(title)
  await page.locator('.sx-palette-item', { hasText: title }).first().click()
}

/** Sets store state, as a script reaches it through the debug hook. */
export function setState(page: Page, patch: Record<string, unknown>): Promise<void> {
  return page.evaluate((p) => (window as unknown as { __sx: Sx }).__sx.setState(p), patch)
}

/** Closes what a test before this one left open: menus, popovers, dialogs. A phone sheet is left to closeSheet. */
export async function dismiss(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('.sx-popover, [role="menu"], [role="dialog"]:not([aria-label="Restore unsaved work?"])').count())) break
    await page.keyboard.press('Escape')
  }
}

/** Opens the Slice tab (on a phone, its only tab). */
export async function goSlice(page: Page): Promise<void> {
  if ((await tab(page, 'prepare').getAttribute('aria-current')) !== 'page') await goTab(page, 'prepare')
  await expect(tab(page, 'prepare')).toHaveAttribute('aria-current', 'page')
}

/** What a new project leaves behind, as project/new.ts clears it: one empty plate and nothing selected, sliced, held or in the timeline. */
const EMPTY = {
  plate: [],
  plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }],
  activePlate: 'plate-1',
  selection: null,
  selectedIds: [],
  layerMarks: {},
  objectSettings: {},
  overrides: {},
  slotSetup: {},
  timeline: { bodies: [], items: [], marker: 0 },
  rollback: null,
  parked: null,
  historyEdit: null,
  slice: { status: 'idle' },
  preview: null,
  hoverSlot: null,
  settingsScope: 'plate',
  // A tool left open, a parked one, and the setup dialog that "Add it by hand" opens, are left behind by a test too.
  objectTool: null,
  setup: null,
}

/** Empties the plate and everything a test hangs on it, on the Slice tab. */
export async function clearPlate(page: Page): Promise<void> {
  await dismiss(page)
  await goSlice(page)
  await setState(page, EMPTY)
}

/** An emptied plate with a 20 mm box on it, through Cmd+K. Returns the box's id. */
export async function box(page: Page): Promise<string> {
  await clearPlate(page)
  await command(page, 'Add a box')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
  return page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate[0]!.id)
}

/** The example plate (Layered X, two filaments) as a fresh start leaves it, with it selected. */
export async function exampleX(page: Page): Promise<void> {
  await clearPlate(page)
  await command(page, 'Start over with the example plate')
  await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plateLoading: boolean } } }).__sx.getState().plateLoading)).toBe(false)
}

/** Switches the settings mode for the test. */
export function mode(page: Page, m: 'simple' | 'advanced' | 'expert'): Promise<void> {
  return setState(page, { settingsMode: m, ...(m === 'simple' ? { expertOpen: false } : {}) })
}

/** The print settings as a fresh start has them: the Quality tab, its sections folded back, no Expert panel. */
export function settingsReset(page: Page): Promise<void> {
  return setState(page, { expertOpen: false, settingsTab: 'quality', settingsSections: {}, settingsPins: [] })
}

/** The panes and the slice look as a fresh start has them: default sizes and the Toolpaths look. */
export function layoutReset(page: Page): Promise<void> {
  return setState(page, { paneSizes: {}, sliceLook: 'toolpaths' })
}

/** Slices the plate with the Slice command and waits for the toolpaths. */
export async function sliceNow(page: Page): Promise<void> {
  const before = await sliceCount(page)
  await command(page, 'Slice the plate')
  await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
}

/** Toolpaths of a current slice of a lone 20 mm box: the one this worker's page already holds, or one sliced now. */
export async function slicedBox(page: Page): Promise<void> {
  await dismiss(page)
  await goSlice(page)
  await setState(page, { sliceLook: 'toolpaths' })
  const names = await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { name: string }[] } } }).__sx.getState().plate.map((p) => p.name))
  if (names.length === 1 && names[0] === 'Box' && (await sliced(page).count())) return
  await box(page)
  await sliceNow(page)
}

/** Runs `body` at another window size and puts the size back, since the page is shared with the tests after this one. */
export async function atSize(page: Page, size: { width: number; height: number }, body: () => Promise<void>): Promise<void> {
  const was = page.viewportSize()!
  try {
    await page.setViewportSize(size)
    await body()
  } finally {
    await page.setViewportSize(was)
  }
}

const INTERACTIVE = 'button, a[href], input, select, textarea, [role=radio], [role=switch], [role=slider], [role=tab], [role=menuitem]'

/** The controls on screen, by tag and label, as a person would count them (minimal UI). */
export async function visibleControls(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const seen = new Set<Element>()
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (seen.has(el)) continue
      seen.add(el)
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
      if (r.right < 0 || r.left > innerWidth) continue
      // A canvas gizmo, the menu list of a closed select, and sr-only skip links do not count.
      if (el.closest('.sr-only, [hidden], [aria-hidden=true]')) continue
      // A setup note's answer (It's dry on the drying note) is not a standing control: the note shows once the settings
      // plan loads, which can land before or after the count, and answering it hides it.
      if (el.closest('.setup-notes')) continue
      // The slow 3D view notice in a phone's top bar is a status, not a settings control: it shows only where the
      // browser draws without the GPU, as CI does, so counting it would make the total depend on the machine.
      if (el.closest('.sx-view-notice')) continue
      // A toast's Details (and its action) go with the note when it expires or is dismissed, so they are not standing
      // controls.
      if (el.closest('.sx-toasts')) continue
      // Hover-revealed controls (opacity 0 on the control or a parent) are not on screen.
      let hidden = false
      for (let p: Element | null = el; p; p = p.parentElement) if (Number(getComputedStyle(p).opacity) === 0) hidden = true
      if (hidden) continue
      // A segmented group or a row of axis fields reads as one control.
      const group = el.closest('[role=radiogroup], .tf-row')
      if (group) {
        if (seen.has(group)) continue
        seen.add(group)
      }
      out.push(`${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 28)}`)
    }
    return out
  }, INTERACTIVE)
}

/** A toast's box on the page. */
export type Box = { x: number; y: number; width: number; height: number }

/**
 * Posts a toast the way the app does and returns its box once its entry animation has settled. Both happen in the
 * page, since a toast leaves after 2.6 s and a busy test machine can take that long between two steps.
 */
export async function postToast(page: Page, label: string): Promise<Box> {
  // Each toast reads differently: one with the same words as a toast still on its way out can be taken for it and never
  // drawn, which leaves nothing to measure. Zero-width spaces tell them apart without making the toast any wider, since
  // the checks below are about a few pixels of room.
  const text = `${label}${'\u200b'.repeat(++posted)}`
  return page.evaluate(async (t) => {
    const id = Date.now()
    ;(window as unknown as { __sx: Sx }).__sx.setState({ toast: { id, text: t, tone: 'info' } })
    const find = () => [...document.querySelectorAll<HTMLElement>('[data-testid="toast"]')].filter((n) => n.textContent?.includes(t)).pop()
    let el = find()
    for (let i = 0; !el && i < 100; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      el = find()
    }
    if (!el) throw new Error(`no toast reading ${t}`)
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)))
    // The offset follows the overlays a frame later.
    await new Promise((r) => requestAnimationFrame(r))
    // The toasts up at once share one card, and the card is what sits on the page.
    const r = (el.closest<HTMLElement>('[data-testid="toasts"]') ?? el).getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, text)
}
let posted = 0

/**
 * Away from the plate tab a toast keeps its place at the window bottom: clear of the status bar on a desktop window,
 * above the tab bar (or the window edge) on a phone. Leaves the app on the Slice tab again.
 */
export async function toastAwayFromPlate(page: Page): Promise<void> {
  await dismiss(page)
  await setState(page, { workspace: 'printers' })
  try {
    await expect(page.locator('.vp')).toHaveCount(0)
    const toast = await postToast(page, 'Saved the plate.')
    const { width, height } = page.viewportSize()!
    if (width > 900) {
      // It rests clear of the status bar along the window's bottom.
      const bar = (await page.locator('.sx-status').boundingBox())!
      expect(Math.round(bar.y - (toast.y + toast.height))).toBe(8)
    } else {
      // On a phone the toast keeps to the window bottom, above the tab bar when there is one.
      const tabs = page.getByTestId('phone-tabs')
      const tabH = (await tabs.isVisible()) ? (await tabs.boundingBox())!.height : 0
      expect(Math.round(height - (toast.y + toast.height))).toBe(tabH ? Math.round(tabH) + 12 : 28)
    }
  } finally {
    await setState(page, { workspace: 'prepare' })
    await goSlice(page)
  }
}

// ---- the Slice sidebar (a bottom sheet on a phone) -----------------------------------------------------------

export type HandPrinter = { id: string; name: string; profileId: string; vendor: string; model: string; nozzleCount: number }

/** A Bambu Lab A1 mini added by hand, with no connection: it reports no filament slots and is export only. */
export const A1_MINI: HandPrinter = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

/** A Bambu Lab A1 added by hand, with no connection: its filaments are all set in the sidebar. */
export const UNCONNECTED: HandPrinter = { id: 'e2e-desk-a1', name: 'Desk A1', profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }

/** A Bambu Lab H2D added by hand: two nozzles and their slots make the sidebar overflow. */
export const H2D: HandPrinter = { id: 'e2e-h2d', name: 'Two nozzles', profileId: 'bambu-h2d', vendor: 'Bambu Lab', model: 'H2D', nozzleCount: 2 }

/** The printer the sidebar tests start on: the reference printer with its AMS. */
export const BAY_1 = 'bay-1'

/**
 * The printers the sidebar journeys add by hand. The app lists its printers when it loads, so they are in the page's
 * prefs from the start (`test.use({ journeyPrefs: { handPrinters: HAND_PRINTERS, ... } })`) and a test only picks one.
 */
export const HAND_PRINTERS: HandPrinter[] = [A1_MINI, UNCONNECTED, H2D]

/** Picks a printer from the machine card's list, as a person does. */
export async function usePrinter(page: Page, id: string): Promise<void> {
  const now = await page.evaluate(() => (window as unknown as { __sx: { getState(): { printerId: string | null } } }).__sx.getState().printerId)
  if (now === id) return
  await page.getByTestId('slice-machine-printer').click()
  await page.locator(`[data-testid="slice-machine-printer-option"][data-printer-id="${id}"]`).click()
  await expect(page.getByRole('dialog', { name: 'Printer' })).toHaveCount(0)
}

/**
 * The sidebar as a test wants it: the example plate, a settings mode, a printer, the folds as a fresh start has them,
 * and the sidebar open (on a phone, its sheet) at its machine card.
 */
export async function sidebarAs(page: Page, o: { mode?: 'simple' | 'advanced' | 'expert'; printer?: string } = {}): Promise<void> {
  await exampleX(page)
  await setState(page, { sidebarFolds: {}, settingsSections: {}, expertOpen: false, settingsTab: 'quality', paneSizes: {} })
  await mode(page, o.mode ?? 'simple')
  await openSheet(page)
  // The sidebar starts at its top, not where the test before scrolled it.
  await page.evaluate(() => document.querySelectorAll('.sx-rail-body, .pane-body').forEach((el) => { el.scrollTop = 0 }))
  await usePrinter(page, o.printer ?? BAY_1)
  await expect(page.getByTestId('slice-machine-card')).toBeVisible()
}

/** Puts back what a sidebar test may have changed in the app's saved state, and shuts a phone's sheet. */
export async function sidebarDone(page: Page): Promise<void> {
  await dismiss(page)
  await setState(page, { printerNozzles: {}, expertOpen: false, paneSizes: {} })
  await closeSheet(page)
  const now = await page.evaluate(() => (window as unknown as { __sx: { getState(): { printerId: string | null } } }).__sx.getState().printerId)
  if (now !== BAY_1) {
    await openSheet(page)
    await usePrinter(page, BAY_1)
    await closeSheet(page)
  }
}

// ---- steps the desktop and phone journeys both run -----------------------------------------------------------
// The sidebar is a pane on a desktop window and a bottom sheet on a phone. These are the checks whose answer depends
// on which, so sidebar.spec.ts and phone-shell.spec.ts each run them on their own window.

/** The machine card's printer, nozzle and plate boxes change in place, with the printer's name in full. */
export async function machineBoxesChange(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'simple', printer: BAY_1 })
  // The printer's name is never cut to nothing: the printer box has the room the nozzle and plate boxes leave.
  const shownName = page.getByTestId('slice-machine-printer').locator('.printer-name')
  expect(await shownName.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false)
  // The model follows the name, muted: in full, or cut with an ellipsis and in full in the tooltip.
  const model = page.getByTestId('slice-machine-model')
  const full = (await model.textContent()) ?? ''
  expect(full).toMatch(/\S/)
  const shown = await model.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth + 1, ellipsis: getComputedStyle(el).textOverflow }))
  expect(shown.ellipsis).toBe('ellipsis')
  if (shown.cut) await expect(page.getByTestId('slice-machine-printer')).toHaveAttribute('data-tip-title', new RegExp(`^${full}`))
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
  await expect(nozzle).toHaveAttribute('aria-label', /^Nozzle: \d\.\d mm$/)
  await nozzle.click()
  const other = page.locator('[data-testid="slice-machine-nozzle-option"][aria-checked="false"]:not(:disabled)').first()
  if (await other.count()) {
    const mm = await other.getAttribute('data-nozzle')
    await other.click()
    await expect(nozzle).toHaveAttribute('aria-label', `Nozzle: ${mm} mm`)
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
  await expect(plate).toHaveAttribute('aria-label', 'Plate: Cool plate')
  await expect(plate).toHaveAttribute('data-bed-type', 'cool')
  // Every control of the card is on screen at once, with the status beside them.
  await expect(page.getByTestId('slice-machine-status')).toBeVisible()
  await sidebarDone(page)
}

/** The plate type belongs to its plate. On a phone the sidebar sheet closes for the plate picker and opens again for the card. */
export async function plateTypePerPlate(page: Page, pick: { add(): Promise<void>; show(n: number): Promise<void> }): Promise<void> {
  await sidebarAs(page, { mode: 'simple', printer: BAY_1 })
  const plate = page.getByTestId('slice-machine-plate')
  const first = (await plate.getAttribute('aria-label')) ?? ''
  await closeSheet(page)
  await pick.add()
  await openSheet(page)
  await plate.click()
  await page.locator('[data-testid="slice-machine-plate-option"][data-bed-type="smooth-pei"]').click()
  await expect(plate).toHaveAttribute('aria-label', 'Plate: Smooth PEI')
  await closeSheet(page)
  await pick.show(1)
  await expect(plate).toHaveAttribute('aria-label', first)
  await pick.show(2)
  await expect(plate).toHaveAttribute('aria-label', 'Plate: Smooth PEI')
  // Back to the printer's default.
  await openSheet(page)
  await plate.click()
  await page.locator('[data-testid="slice-machine-plate-option"][data-bed-type=""]').click()
  await expect(plate).toHaveAttribute('aria-label', first)
  await sidebarDone(page)
}

/** A printer with no connection reads Export only. */
export async function exportOnly(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'simple', printer: A1_MINI.id })
  await expect(page.getByTestId('slice-machine-printer')).toContainText('Desk A1 mini')
  await expect(page.getByTestId('slice-machine-status')).toHaveText('Export only')
  await sidebarDone(page)
}

/** An object row is one compact line with the name, the parts and their colors, and the count in the header. */
export async function objectRowIsCompact(page: Page, isMobile: boolean): Promise<void> {
  await sidebarAs(page, { mode: 'simple' })
  const row = page.getByTestId('object-row').first()
  const line = row.locator('.obj-row')
  expect(Math.round((await line.boundingBox())!.height)).toBe(isMobile ? 44 : 36)
  await expect(row.getByTestId('object-name')).toHaveText('Layered X')
  await expect(row.locator('.obj-meta')).toHaveText('2 parts')
  await expect(row.locator('.obj-swatches i')).toHaveCount(2)
  await expect(page.locator('[data-section="objects"] .objs-count')).toHaveText('1 on plate')
  // On a fine pointer, lock and print show only on hover. A phone views and prints: print always shows, and lock
  // (an edit) waits for the desktop.
  const lock = row.getByTestId('object-lock')
  if (isMobile) {
    await expect(row.getByTestId('object-printable')).toBeVisible()
    await expect(lock).toHaveCount(0)
  } else {
    await page.mouse.move(0, 0)
    await expect(lock).toBeHidden()
    await line.hover()
    await expect(lock).toBeVisible()
    await page.mouse.move(0, 0)
  }
  await sidebarDone(page)
}

/** An empty plate says so and points at Add. */
export async function emptyPlateSaysSo(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'simple' })
  await setState(page, { plate: [], selection: null, selectedIds: [] })
  const card = page.locator('[data-section="objects"]')
  await expect(card).toContainText('Nothing on the plate yet.')
  await expect(card).toContainText('Drop STL, 3MF or STEP files anywhere.')
  await expect(card.getByTestId('objects-add-model')).toBeVisible()
  await sidebarDone(page)
}

export type FilamentSx = {
  getState(): { selectedIds: string[]; printerSlots: { material?: string; color?: string }[]; hoverSlot: number | null }
  setState(p: unknown): void
}

/** A spool on the rail by its number. */
export const slot = (page: Page, n: number) => page.locator(`[data-testid="slice-filament-slot"][data-slot="${n}"]`)

/** Hovering or focusing a slot picks its filament out in the viewport, and leaving clears it. */
export async function slotHighlights(page: Page, isMobile: boolean): Promise<void> {
  await sidebarAs(page, { mode: 'simple' })
  await expect(page.getByTestId('slice-filament-rail')).toBeVisible()
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
  await sidebarDone(page)
}

/** Every loaded spool shows; the ones in use carry an edge and a part count; a click moves nothing on screen. */
export async function spoolsShow(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'simple' })
  await expect(page.getByTestId('slice-filament-rail')).toBeVisible()
  const loaded = await page.evaluate(() => (window as unknown as { __sx: FilamentSx }).__sx.getState().printerSlots.length)
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
  // A click on a spool moves the selection to it (packages/app/test/filament-pick.test.ts:80-121) and moves nothing on screen.
  const boxes = () => page.locator('[data-section="filament"] .slot-rail-wrap, [data-testid="slice-filament-slot"], [data-testid="slice-filament-target"], [data-testid="slice-filament-slot-line"], [data-testid="slice-filament-note"], [data-testid="slice-filament-foot"]').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 2) / 2) }))
  const free = Number(await page.locator('[data-testid="slice-filament-slot"][data-parts="0"]:not([data-empty])').first().getAttribute('data-slot'))
  // A click scrolls its spool into view, so the rail is in view first: only the click is measured.
  await page.getByTestId('slice-filament-rail').scrollIntoViewIfNeeded()
  await slot(page, free).scrollIntoViewIfNeeded()
  const at = await boxes()
  await slot(page, free).click()
  await expect(slot(page, free)).toHaveAttribute('aria-pressed', 'true')
  expect(await boxes()).toEqual(at)
  await sidebarDone(page)
}

/** A full section wraps inside the card, never the page. */
export async function fullSectionWraps(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'simple' })
  const was = await page.evaluate(() => (window as unknown as { __sx: { getState(): { printerId: string | null; printerSlots: unknown[] } } }).__sx.getState())
  try {
    const setup = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, { type: 'PLA', brand: '', color: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][i % 4] }]))
    await setState(page, { printerId: null, slotSetup: setup, printerSlots: [] })
    await expect(page.getByTestId('slice-filament-slot')).toHaveCount(16)
    const rail = page.getByTestId('slice-filament-rail')
    const sizes = await rail.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    // Four to a row: the fifth starts the second row under the first.
    const [one, five] = [await slot(page, 1).boundingBox(), await slot(page, 5).boundingBox()]
    expect(five!.x).toBeCloseTo(one!.x, 0)
    expect(five!.y).toBeGreaterThan(one!.y)
    await slot(page, 16).scrollIntoViewIfNeeded()
    await expect(slot(page, 16)).toBeInViewport()
  } finally {
    await setState(page, { printerId: was.printerId, slotSetup: {}, printerSlots: was.printerSlots })
    await sidebarDone(page)
  }
}

/** The Filament options menu sits on top of the nozzle rows under it. */
export async function optionsMenuOnTop(page: Page, isMobile: boolean): Promise<void> {
  // A folding Filament card (advanced settings) on a two-nozzle hotend rack printer whose AMS has not reported yet: the
  // rail is short, so the menu hangs over the nozzle switch and the hotend rack buttons.
  await sidebarAs(page, { mode: isMobile ? 'simple' : 'advanced', printer: 'bay-6' })
  const was = await page.evaluate(() => (window as unknown as { __sx: FilamentSx }).__sx.getState().printerSlots)
  try {
    await setState(page, { printerSlots: [], slotSetup: {} })
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
    // the short rail puts something under the menu at desktop widths, so the check above is not empty
    if (!isMobile) expect(hits.under.length).toBeGreaterThan(0)
    expect(hits.under.every(Boolean)).toBe(true)
    // the menu still works where it overlaps a rack button: the click lands on the menu, not the rack under it
    const rack = await racks.first().inputValue()
    await menu.getByTestId('slice-filament-calibrate').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { calibrationOpen: boolean } } }).__sx.getState().calibrationOpen)).toBe(true)
    expect(await racks.first().inputValue()).toBe(rack)
    await expect(page.getByRole('dialog')).toBeVisible()
  } finally {
    await dismiss(page)
    await setState(page, { calibrationOpen: false, printerSlots: was })
    await sidebarDone(page)
  }
}

/** Add filament shows under the spools of a printer with no connection, opens the new filament, and moves nothing. */
export async function addFilamentMovesNothing(page: Page, settingsMode: 'simple' | 'expert'): Promise<void> {
  await sidebarAs(page, { mode: settingsMode, printer: UNCONNECTED.id })
  try {
    const foot = page.getByTestId('slice-filament-foot')
    // The line under the rail reads its hint, or a setup note in the hint's place once the settings plan has one.
    await expect(async () => {
      const note = await foot.getByRole('status', { name: 'Setup notes' }).count()
      expect(note > 0 || /^Right-click a filament to change it\.$/.test(await foot.locator('.rail-foot-text').innerText())).toBe(true)
    }).toPass()
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
  } finally {
    await setState(page, { slotSetup: {} })
    await sidebarDone(page)
  }
}
