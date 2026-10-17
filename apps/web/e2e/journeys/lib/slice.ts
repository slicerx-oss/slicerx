// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shared steps for the slice journeys (slicing-preview, tower, printer-bridge, phone-slice). A journey shares one page
// per worker, so each test starts from whatever the one before left. `calm` puts the parts of the page these tests
// touch back to a known state, and `sliceBox` slices a 20 mm box once per page: a later test that finds the same slice
// still current and untouched uses it, and one that changed the plate or the result slices again.
import { test, type Locator, type Page } from '@playwright/test'
import { closeSheet, expect, goTab, sliceCount, sliced, viewSized } from '../../fixtures'
import { examplePlate, setFlags } from './model'

export interface Mark {
  id: string
  z: number
  kind: string
  slot?: number
  gcode?: string
}
export interface Collision {
  title?: string
  layer: number
  severity: string
}
export interface Tower {
  x: number
  y: number
  width: number
  depth: number
  reason: string
}
export interface Result {
  id: string
  warnings?: unknown[]
  collisions?: Collision[]
  layerTimeS?: ArrayLike<number>
  stats?: { timeS: number; prepareS?: number }
  primeTower?: Tower
}
export interface SlotNote {
  type: string
  brand: string
  color: string
}
/** The parts of the app's store these journeys read; anything else is reached through `patch`. */
export interface Snap {
  plate: { id: string; name: string; transform: number[] }[]
  plates: { id: string; settings: Record<string, unknown> }[]
  activePlate: string
  workspace: string
  modelMode: string
  sliceLook: string
  preview: { layerZ: ArrayLike<number>; layerCount: number } | null
  layerHi: number
  strikePick: number | null
  selectedIds: string[]
  slice: { status: string; stale?: boolean; message?: string; result?: Result }
  autoSlice: boolean
  overrides: Record<string, unknown>
  layerMarks: Record<string, Mark[]>
  slotSetup: Record<number, SlotNote>
  tower: { auto: boolean; x: number; y: number }
  towerSelected: boolean
  showToolhead: boolean
  showGantry: boolean
  printerId: string | null
  handPrinters: unknown[]
  rails: Record<string, { left?: boolean; right?: boolean } | undefined>
  [key: string]: unknown
}
export type Store = { getState(): Snap; setState(p: unknown): void }
type Win = { __sx: Store; __vp?: unknown; __stash?: Stash }
/** What the page keeps for these tests, so it survives from one test to the next. */
interface Stash {
  /** The example plate of a page's first load, or null when the page was not showing it when the stash was made. */
  layeredX: Snap['plate'] | null
  printerId: string | null
  base?: { result: unknown; plate: unknown; key: string }
  layered?: { result: unknown }
}

const watched = new WeakSet<Page>()

export const state = (page: Page): Promise<Snap> => page.evaluate(() => (window as unknown as Win).__sx.getState())
export const patch = (page: Page, p: Record<string, unknown>): Promise<void> => page.evaluate((p) => (window as unknown as Win).__sx.setState(p), p)

/** The desktop window the journeys start from. */
export const DESKTOP = { width: 1440, height: 900 }

/**
 * The store and the viewport handle (`__sx`, `__vp`) exist when `slicerx.debug` is set before the app loads, which
 * journey.ts does for every load; a page that lost them is loaded again once. The Layered X plate and the printer the
 * page started with are kept in the page for `layeredX` and `calm`, so call this again after a reload.
 */
export async function debugHooks(page: Page): Promise<void> {
  // A page that lives for a worker should say when the app throws or the tab crashes, or a later test only sees a blank page.
  if (!watched.has(page)) {
    watched.add(page)
    page.on('pageerror', (e) => console.log(`page error: ${e.message}`.slice(0, 600)))
    page.on('crash', () => console.log('the page crashed'))
  }
  if (!(await page.evaluate(() => '__sx' in window))) {
    await page.evaluate(() => localStorage.setItem('slicerx.debug', '1'))
    await page.reload()
    await page.locator('.obj-name', { hasText: 'Layered X' }).waitFor()
  }
  await ensureStash(page)
}

/**
 * Makes the page's stash if it has none (a load starts without one): the printer it shows, and the plate when that is
 * the example plate. A page that other journeys used before this one shows something else, and `layeredX` then loads
 * the example plate when a test asks for it.
 */
async function ensureStash(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Win
    if (w.__stash) return
    const s = w.__sx.getState()
    w.__stash = { layeredX: s.plate.some((p) => p.name === 'Layered X') ? s.plate : null, printerId: s.printerId }
  })
}

/**
 * The example plate (Layered X) on the plate with its meshes loaded. A mesh is let go of a second after nothing holds it
 * (plate/mesh-release.ts), so once a test has emptied the plate the stashed plate's meshes may be gone, and a slice of
 * that plate fails with "Mesh mesh-1 is not loaded". So the stashed plate is used only while it is the one on show; any
 * other plate on show is replaced by a new example plate, which is then the stashed one.
 */
export async function layeredX(page: Page): Promise<void> {
  await ensureStash(page)
  const kept = await page.evaluate(() => {
    const w = window as unknown as Win
    return w.__sx.getState().plate === w.__stash!.layeredX
  })
  if (!kept) {
    await examplePlate(page)
    // The new plate comes up selected; nothing is selected when the stashed plate is on show, and a selection changes
    // what Escape does (in Slice it clears the selection before a dialog gets it).
    await page.evaluate(() => {
      const w = window as unknown as Win
      w.__stash!.layeredX = w.__sx.getState().plate
      delete w.__stash!.layered
      w.__sx.setState({ selection: null, selectedIds: [] })
    })
  }
  await expect.poll(async () => (await state(page)).plate.map((p) => p.name)).toContain('Layered X')
}

/**
 * Puts the page back to the Slice tab at the desktop size with the right pane at its journey default (open), Auto slice
 * off, no layer pins, no menu or dialog open, and the printer it started with. A page that a Model journey used before
 * is brought back too: a phone CAD journey leaves it as the CAD-only studio (no Slice tab), and a desktop one leaves
 * Model on show with its tool open. `mode` is the settings mode; `keepPrinter` leaves the printer as it is.
 */
export async function calm(page: Page, mode: 'simple' | 'advanced' = 'advanced', options: { keepPrinter?: boolean } = {}): Promise<void> {
  // The CAD-only studio is read once at the start, so leaving it takes a new load (which also loses the stash).
  await setFlags(page, { 'slicerx.e2e.cadOnly': null })
  await ensureStash(page)
  // A dialog or a menu an earlier test left open (printer setup, Settings) shuts with Escape, one layer at a time.
  const open = page.locator('dialog[open], [role="dialog"], [role="menu"]')
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Escape')
    if ((await open.count()) === 0) break
  }
  // On a phone the side panes are sheets, and one a test left open covers the tabs and the bar.
  await closeSheet(page)
  await clearToasts(page)
  await page.evaluate(([mode, keepPrinter]) => {
    sessionStorage.setItem('sx-right-pane', 'open')
    const w = window as unknown as Win
    const s = w.__sx.getState()
    w.__sx.setState({
      workspace: 'prepare',
      autoSlice: false,
      settingsMode: mode,
      layerMarks: {},
      toast: null,
      rails: { ...s.rails, preview: undefined },
      rightShut: null,
      objectTool: null,
      parked: null,
      historyEdit: null,
      rollback: null,
      ...(keepPrinter || !w.__stash ? {} : { printerId: w.__stash.printerId }),
    })
  }, [mode, !!options.keepPrinter] as const)
  // Model keeps its own tab, which the Slice views (toolpaths, the Slice button) are not on.
  const sliceTab = page.locator('.sx-tab[data-mode="slice"]')
  if ((await sliceTab.isVisible()) && (await sliceTab.getAttribute('aria-current')) !== 'page') await sliceTab.click()
  // The project's own window: the desktop size here, the phone's on the phone project.
  const home = test.info().project.use.viewport ?? DESKTOP
  const size = page.viewportSize()
  if (!size || size.width !== home.width || size.height !== home.height) await page.setViewportSize(home)
  // The panes open or shut and the playback bar folds to the new width in their own time.
  await viewSized(page)
}

/**
 * Dismisses every toast that stays until it is dismissed (an error or a warning), and waits for the others to go: in a
 * page that lives for a whole worker one of them would sit over the edge tabs and menus and take their clicks.
 */
export async function clearToasts(page: Page): Promise<void> {
  const dismiss = page.getByTestId('toast-dismiss')
  for (let i = 0; i < 10 && (await dismiss.count()) > 0; i++) await dismiss.first().click({ timeout: 5_000 }).catch(() => undefined)
  // The ones that go by themselves take their reading time, and until then they take the clicks under them.
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined)
}

/**
 * A hand-added printer with no connection (an export-only printer), made the current one; `null` makes the printer the
 * page started with the current one again. The hand printers stay in the list: taking one away while the app still
 * asks the fleet about it throws in the fleet's own status call and blanks the page. The fleet list is read again for
 * the change.
 */
export async function handPrinter(page: Page, printer: { id: string; name: string; profileId: string; vendor: string; model: string; nozzleCount: number } | null): Promise<void> {
  await page.evaluate((printer) => {
    const w = window as unknown as Win
    const s = w.__sx.getState()
    const known = s.handPrinters as { id: string }[]
    w.__sx.setState({
      handPrinters: printer && !known.some((h) => h.id === printer.id) ? [...known, printer] : known,
      printerId: printer ? printer.id : (w.__stash?.printerId ?? s.printerId),
      linkEpoch: ((s['linkEpoch'] as number | undefined) ?? 0) + 1,
    })
  }, printer)
}

/**
 * A 20 mm box on the plate, sliced and showing its toolpaths, with the layer slider at the top. The slice is made once
 * per page: when the plate still holds the box, the result is the one this made and nothing has marked it stale or
 * changed it (a test that put a strike or a warning on it replaced the object), it is reused. `overrides` are the
 * process settings the slice is made with.
 */
export async function sliceBox(page: Page, options: { overrides?: Record<string, string>; mode?: 'simple' | 'advanced' } = {}): Promise<void> {
  const { overrides = {}, mode = 'advanced' } = options
  await calm(page, mode)
  const key = JSON.stringify(overrides)
  const current = await page.evaluate((key) => {
    const w = window as unknown as Win
    const s = w.__sx.getState()
    const b = w.__stash?.base
    return !!b && b.key === key && s.slice.status === 'done' && !s.slice.stale && s.slice.result === b.result && s.plate.length === 1 && s.plate[0] === b.plate && JSON.stringify(s.overrides) === key
  }, key)
  if (!current) {
    await patch(page, { overrides, slotSetup: {}, slice: { status: 'idle' } })
    await boxOnPlate(page)
    await startSlice(page)
    await remember(page, overrides)
  }
  await toTop(page)
}

/** Takes the slice on the screen, of the one box on the plate, as the base `sliceBox` hands to the next test. */
export async function remember(page: Page, overrides: Record<string, string> = {}): Promise<void> {
  await page.evaluate((key) => {
    const w = window as unknown as Win
    const s = w.__sx.getState()
    w.__stash!.base = { result: s.slice.result, plate: s.plate[0], key }
  }, JSON.stringify(overrides))
}

/** Keeps some store values in the page, for `restore` to put back after a test that changes them. */
export async function keep(page: Page, ...keys: string[]): Promise<void> {
  await page.evaluate((keys) => {
    const w = window as unknown as Win & { __kept?: Record<string, unknown> }
    const s = w.__sx.getState()
    w.__kept = Object.fromEntries(keys.map((k) => [k, s[k]]))
  }, keys)
}

/** Puts back what `keep` took. */
export async function restore(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Win & { __kept?: Record<string, unknown> }
    if (w.__kept) w.__sx.setState(w.__kept)
  })
}

/** Process settings and loaded slots back to none, touching the store only when something was set (a change marks the slice stale). */
export async function plain(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Win
    const s = w.__sx.getState()
    if (Object.keys(s.overrides).length) w.__sx.setState({ overrides: {} })
    if (Object.keys(s.slotSetup).length) w.__sx.setState({ slotSetup: {} })
  })
}

/** Moves every object on the plate `dx` mm along X, which marks a slice stale (and starts one, with Auto slice on). */
export async function nudge(page: Page, dx: number): Promise<void> {
  await page.evaluate((dx) => {
    const sx = (window as unknown as Win).__sx
    sx.setState({ plate: sx.getState().plate.map((e) => ({ ...e, transform: e.transform.map((v, i) => (i === 12 ? v + dx : v)) })) })
  }, dx)
}

/** Slices the plate from the palette and waits for the toolpaths of a slice that finished after this call. */
export async function startSlice(page: Page): Promise<void> {
  const n = await sliceCount(page)
  if (test.info().project.use.isMobile) {
    // A phone has its Slice button in a sheet: the key slices from the view.
    const slice = page.getByRole('button', { name: 'Slice plate' })
    if (await slice.isVisible()) await slice.click()
    else {
      await page.mouse.click(300, 250)
      await page.keyboard.press('ControlOrMeta+Enter')
    }
  } else await command(page, 'Slice the plate')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
}

/** The plate emptied and one 20 mm box on it, from the palette. */
export async function boxOnPlate(page: Page): Promise<void> {
  await patch(page, { plate: [], selection: null, selectedIds: [] })
  await command(page, 'Add a box')
  await expect.poll(async () => (await state(page)).plate.length).toBe(1)
}

/**
 * Runs a command from Cmd+K by its title. When the palette does not open for the key, it says what had the focus and
 * what else was open, and presses the key once more.
 */
export async function command(page: Page, title: string): Promise<void> {
  const palette = page.getByRole('dialog', { name: 'Commands' })
  await page.keyboard.press('ControlOrMeta+k')
  try {
    await expect(palette).toBeVisible({ timeout: 5_000 })
  } catch {
    const seen = await page.evaluate(() => ({ focus: document.activeElement?.outerHTML.slice(0, 160), open: [...document.querySelectorAll('dialog[open], [role=dialog], [role=menu]')].map((d) => d.getAttribute('aria-label') ?? d.className), toasts: document.querySelectorAll('[data-testid="toast"]').length }))
    test.info().annotations.push({ type: 'palette did not open', description: JSON.stringify(seen) })
    if (!(await palette.isVisible())) await page.keyboard.press('ControlOrMeta+k')
    await expect(palette, JSON.stringify(seen)).toBeVisible()
  }
  await page.keyboard.type(title)
  await page.locator('.sx-palette-item', { hasText: title }).first().click()
}

/** The Layered X plate of the first load, sliced and showing its toolpaths, with the slice kept the way `sliceBox` keeps the box's. */
export async function sliceLayered(page: Page, mode: 'simple' | 'advanced' = 'advanced'): Promise<void> {
  await calm(page, mode)
  await plain(page)
  await layeredX(page)
  const current = await page.evaluate(() => {
    const w = window as unknown as Win
    const s = w.__sx.getState()
    return !!w.__stash?.layered && s.slice.status === 'done' && !s.slice.stale && s.slice.result === w.__stash.layered.result && s.plate === w.__stash.layeredX
  })
  if (!current) {
    await patch(page, { slice: { status: 'idle' } })
    await startSlice(page)
    await page.evaluate(() => {
      const w = window as unknown as Win
      w.__stash!.layered = { result: w.__sx.getState().slice.result }
    })
  }
  await toTop(page)
}

/** Brings the app back to the Slice tab before it loads again, so the plate comes up (the last tab a test left is kept). */
export async function toSlice(page: Page): Promise<void> {
  await patch(page, { workspace: 'prepare' })
  await page.evaluate(() => {
    const raw = localStorage.getItem('slicerx.prefs.v1')
    if (raw) localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ ...JSON.parse(raw), workspace: 'prepare' }))
  })
}

/** The layer slider at the last layer and the toolpaths showing, as a slice leaves them. */
export async function toTop(page: Page): Promise<void> {
  const s = await state(page)
  await patch(page, { sliceLook: 'toolpaths', layerHi: s.preview?.layerCount ?? 1e9, strikePick: null })
  await expect(sliced(page)).toBeVisible()
}

/** Where a point on the bed (mm, x y z) shows on the screen, through the viewport's own camera. */
export function screenOf(page: Page, x: number, y: number, z = 0.1): Promise<{ x: number; y: number }> {
  interface Vp {
    camera: { position: { clone(): { set(x: number, y: number, z: number): { applyMatrix4(m: unknown): { project(c: unknown): { x: number; y: number } } } } } }
    stage: { bedRoot: { matrixWorld: unknown } }
    canvas: HTMLCanvasElement
  }
  return page.evaluate(
    ([x, y, z]) => {
      const vp = (window as unknown as { __vp: Vp }).__vp
      const v = vp.camera.position.clone().set(x as number, y as number, z as number).applyMatrix4(vp.stage.bedRoot.matrixWorld).project(vp.camera)
      const r = vp.canvas.getBoundingClientRect()
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
    },
    [x, y, z] as const,
  )
}

/** Chooses a printer by name in the Slice sidebar's printer list, unless it is the current one. */
export async function usePrinter(page: Page, name: RegExp): Promise<void> {
  const chip = page.getByTestId('slice-machine-printer')
  if (name.test((await chip.textContent()) ?? '')) return
  await chip.click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name }).first().click()
  await expect(chip).toContainText(name)
}

/**
 * The live view of one printer from the Printers page: the panels over the camera, the drawers by mouse and keyboard,
 * an approval before a pause, and the way back. The demo fleet answers; it needs no bridge. Desktop and phone.
 */
export async function printerHud(page: Page, isMobile: boolean): Promise<void> {
  await goTab(page, 'printers')
  await expect(page.getByRole('heading', { name: 'Printers' })).toBeVisible()
  await page.locator('.pcard').filter({ hasText: 'Bay 1' }).getByRole('button', { name: 'Bay 1', exact: true }).click()
  const hud = page.getByRole('region', { name: 'Bay 1 live view' })
  await expect(hud).toBeVisible()
  await expect(hud).toHaveAttribute('data-layout', isMobile ? 'phone' : 'wide')
  await expect(hud.getByRole('progressbar', { name: 'Bay 1 progress' })).toBeVisible()

  // The temperatures open from their tab and close with Esc, focus going back to the tab.
  const tab = hud.getByRole('button', { name: 'Show temperatures and fans' })
  await tab.click()
  const temps = hud.getByRole('complementary', { name: 'Temperatures and fans' })
  await expect(temps).toBeVisible()
  await expect(temps.getByRole('meter', { name: 'Part cooling fan' })).toHaveAttribute('aria-valuenow', '100')
  await page.keyboard.press('Escape')
  await expect(temps).toBeHidden()
  await expect(tab).toBeFocused()

  // The filament drawer opens from the keyboard and names the slot printing now.
  await hud.getByRole('button', { name: 'Show filament' }).focus()
  await page.keyboard.press('Enter')
  const filament = hud.getByRole('complementary', { name: 'Filament' })
  await expect(filament).toBeVisible()
  await expect(filament.locator('.ph-slot[data-active]')).toContainText('Printing now')
  await filament.getByRole('button', { name: 'Close filament' }).click()
  await expect(filament).toBeHidden()

  // Pause goes through the approval card; denying it leaves the print running.
  await hud.getByRole('button', { name: 'Pause' }).click()
  const card = page.getByRole('dialog', { name: /Pause the print on Bay 1/ })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Deny' }).click()
  await expect(hud.getByRole('button', { name: 'Pause' })).toBeVisible()

  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await hud.getByRole('button', { name: 'Back to all printers' }).click()
  await expect(page.locator('.pcard')).toHaveCount(6)
  await goTab(page, 'prepare')
}

/** A real finger tap: down for 60 ms through the browser's touch input, as a person's is. */
export async function tap(page: Page, at: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
  await page.waitForTimeout(60)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/**
 * Taps until `done` passes. On a loaded machine the page can be busy past the half second that makes a press a long
 * press, which shows the tip and takes no tap (phone-responsive.spec.ts); a person whose tap showed a tip taps again too.
 */
export async function tapFor(page: Page, at: () => Promise<{ x: number; y: number }>, done: () => Promise<unknown>): Promise<void> {
  await expect(async () => {
    await tap(page, await at())
    await done()
  }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] })
}

export const center = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** The pin for one mark, by the start of its accessible name ("Pause at layer 20"). */
export const pin = (page: Page, name: string): Locator => page.locator(`.layer-mark:not(.strike-mark)[aria-label^="${name},"]`)

/**
 * Marks at these layers (1-based), straight into the store; a third value `below` puts the mark that far under the
 * layer's top, so it still shows on that layer. `heads` is how many pins show, when some share a "+N" pin.
 */
export async function marks(page: Page, list: ([number, string] | [number, string, number])[], heads = list.length): Promise<void> {
  await page.evaluate((list) => {
    const sx = (window as unknown as Win).__sx
    const s = sx.getState()
    const z = s.preview!.layerZ
    sx.setState({
      layerMarks: { [s.activePlate]: list.map(([l, kind, below], i) => ({ id: `m${i}`, z: Math.round((z[l - 1]! - (below ?? 0)) * 1e4) / 1e4, kind, ...(kind === 'custom' ? { gcode: 'M117 Hi' } : {}) })).sort((a, b) => a.z - b.z) },
    })
  }, list)
  await expect(page.locator('.layer-mark:not(.strike-mark)')).toHaveCount(heads)
}

export const layerHi = async (page: Page): Promise<number> => (await state(page)).layerHi
export const layerCount = async (page: Page): Promise<number> => (await state(page)).preview!.layerCount

/** Where the Layer slider's thumb center sits at `layer`, from the track box (a 13 px thumb). */
export async function thumbX(page: Page, layer: number): Promise<number> {
  const b = (await page.locator('#pv-layer').boundingBox())!
  const n = await layerCount(page)
  return b.x + 6.5 + ((layer - 1) / (n - 1)) * (b.width - 13)
}

/**
 * Every control on the page whose box the settled tip touches: the tip covers none of the playback bar's controls
 * (play, back, the sliders, the plate chip over it) and no other pin.
 */
export async function tipCovers(page: Page, tip: Locator): Promise<string[]> {
  await expect(tip).toHaveAttribute('data-ready', 'true')
  await tip.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  let last = ''
  await expect.poll(async () => {
    const was = last
    last = JSON.stringify(await tip.boundingBox())
    return was === last
  }).toBe(true)
  const t = (await tip.boundingBox())!
  return page.evaluate((t) => {
    const out: string[] = []
    const controls = 'button, a[href], input, select, textarea, summary, [role=button], [role=slider], [role=tab], [role=menuitem], [role=switch], [role=radio], [role=checkbox]'
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(controls))) {
      if (el.closest('#sx-tip')) continue
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      if (!r.width || !r.height || st.visibility === 'hidden' || st.opacity === '0') continue
      if (r.left < t.x + t.width - 0.5 && t.x + 0.5 < r.right && r.top < t.y + t.height - 0.5 && t.y + 0.5 < r.bottom) out.push(`${(el.getAttribute('aria-label') ?? el.textContent ?? el.className).toString().trim().slice(0, 30)} ${[r.x, r.y, r.width, r.height].map(Math.round).join(' ')}`)
    }
    return out
  }, t)
}

/** The bar's play and back buttons, which a tip over the bar must never touch. */
export const transport = (dock: Locator) => ['Play print', 'Previous layer', 'Next layer'].map((n) => dock.getByRole('button', { name: n }))

type Box = { x: number; y: number; width: number; height: number }
/** Whether two boxes do not overlap. */
export const clear = (a: Box, b: Box): boolean => a.y + a.height <= b.y || a.y >= b.y + b.height || a.x + a.width <= b.x || a.x >= b.x + b.width

/** The middle of the Layered X model in bed coordinates (mm), where the X's arms cross. */
export async function layeredMid(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const e = (window as unknown as { __sx: { getState(): { plate: { name: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }[] } } }).__sx.getState().plate.find((p) => p.name === 'Layered X')!
    const m = e.transform
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const part of e.parts)
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
        for (let k = 0; k < 3; k++) {
          const w = m[k]! * x + m[k + 4]! * y + m[k + 8]! * z + m[k + 12]!
          min[k] = Math.min(min[k]!, w)
          max[k] = Math.max(max[k]!, w)
        }
      }
    return [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2) as [number, number, number]
  })
}
