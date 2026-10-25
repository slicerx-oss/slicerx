// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: slice a plate and read the result. Auto slice and its stale flag, a refused slice, copies, the Slice footer's
// estimate, what the plate sends to the engine, the layer and move sliders, print by object, one print time everywhere,
// the right pane, Show me on a block, the layer pins, and the Slice tab as people first see it, the Print sheet, and
// the G-code a slice writes (seam paint, calibration tests, layer marks, per-printer start G-code, nozzle size, brim
// ears, the date stamp).
// The page is shared by a worker's tests (journey.ts), so a test starts with `sliceBox` or `calm`, which slice a 20 mm
// box once per page and put the rest of the page back. Layered X is on the plate only where a test needs its two
// filaments or its estimate (copies, print time).
// The phone legs are in phone-slice.spec.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Locator, type Page } from '@playwright/test'
import { expectFileDialog, interceptFileDialogs } from '../file-dialog'
import { pressable, reducedMotion, steady } from '../canvas-press'
import { addMenu, panesSettled, plateReady, prepareContext, preparePage, setPartFilament, sliceCount, sliced, tab, viewSized } from '../fixtures'
import { expect, journey as test } from '../journey'
import { plateSheet, shutPlateSheet } from '../plate-project'
import { boxOnPlate, calm, center, clear, clearToasts, command, debugHooks, handPrinter, keep, layerCount, layerHi, layeredMid, layeredX, marks, nudge, patch, pin, plain, remember, restore, screenOf, sliceBox, sliceLayered, startSlice, state, thumbX, tipCovers, transport, type Snap } from './lib/slice'

test.skip(({ isMobile }) => isMobile, 'Desktop layout; the phone legs are in phone-slice.spec.ts')

test.beforeAll(async ({ app }) => {
  // A project opened by Ctrl+O comes through the file dialog the page intercepts (layer pins).
  interceptFileDialogs(app)
  await debugHooks(app)
})

type Vp = { stats(): { segments: number }; getCamera(): { target: number[] } }
const segments = (page: Page) => page.evaluate(() => (window as unknown as { __vp?: Vp }).__vp?.stats().segments ?? -1)
const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

// ---- Auto slice, a refused slice, the slice track ----

test('slices in the background after an edit, and the Slice button returns when Auto slice is off', async ({ page }) => {
  test.slow()
  await sliceBox(page)
  const read = async () => {
    const s = await state(page)
    return { status: s.slice.status, stale: s.slice.stale ?? false, id: s.slice.result?.id ?? null, auto: s.autoSlice }
  }
  try {
    // Always: Auto would hold a plate whose last slice took as long as a test runner's. The box moves a little, so the
    // first background slice starts on its own.
    await patch(page, { autoSlice: true, autoSliceBySize: false })
    await nudge(page, 1)
    expect((await read()).auto).toBe(true)
    await expect(page.getByRole('main').getByRole('button', { name: /^Slice/ })).toHaveCount(0)
    // The first slice starts on its own. Its progress has the button's place while it runs; then Print is the action.
    const before = (await read()).id
    await expect.poll(async () => { const s = await read(); return s.status === 'done' && !s.stale && s.id !== before }, { timeout: 120_000 }).toBe(true)
    await expect(page.getByRole('button', { name: /^Print( on .+)?$/ })).toBeVisible()
    // An edit makes the result stale at once, then a new slice (a new id) makes it current again.
    const first = (await read()).id
    // Read in the same turn as the edit, before the new slice can start: a later read can find that slice running.
    const after = await page.evaluate(() => {
      const st = (window as unknown as { __sx: { getState(): Snap; setState(p: unknown): void } }).__sx
      st.setState({ overrides: { sparse_infill_density: '25%' } })
      const sl = st.getState().slice
      return { status: sl.status, stale: sl.stale ?? false }
    })
    expect(after).toEqual({ status: 'done', stale: true })
    await expect.poll(async () => { const s = await read(); return s.status === 'done' && !s.stale && s.id !== first }, { timeout: 120_000 }).toBe(true)
    // Off: nothing slices on its own and a Slice button shows. The current slice keeps Print, with Slice again under it.
    await patch(page, { autoSlice: false })
    await expect(page.getByRole('main').getByRole('button', { name: /^Slice/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Print( on .+)?$/ })).toBeVisible()
  } finally {
    await patch(page, { autoSlice: false, overrides: {} })
  }
})

test('a refused slice clears the toolpaths of the slice before it', { tag: '@smoke' }, async ({ page }) => {
  await sliceBox(page)
  await expect.poll(() => segments(page)).toBeGreaterThan(0)
  try {
    // Half a meter to the right, off any bed, with Auto slice on Always so the move slices at once (Auto would hold a
    // plate whose last slice took as long as a test runner's).
    await patch(page, { autoSlice: true, autoSliceBySize: false })
    await nudge(page, 500)
    await expect.poll(async () => (await state(page)).slice.status, { timeout: 60_000 }).toBe('error')
    expect((await state(page)).preview).toBeNull()
    await expect.poll(() => segments(page)).toBe(0)
    await expect(page.getByRole('button', { name: 'Export G-code' })).toHaveCount(0)
  } finally {
    await patch(page, { autoSlice: false })
  }
})

test('the Estimate block keeps its height while a slice runs, and muninn stays clear of its text', { tag: '@smoke' }, async ({ page }) => {
  await calm(page, 'simple')
  await patch(page, { slice: { status: 'idle' } })
  const block = page.locator('[data-section="estimate"]').first()
  await block.scrollIntoViewIfNeeded()
  const idle = await block.boundingBox()
  // A slice that runs for a while: the store says so, as the engine's progress would.
  await patch(page, { slice: { status: 'running', progress: { stage: 'paths', fraction: 0.55 }, startedAt: Date.now() } })
  const track = page.getByTestId('slice-track')
  await expect(track).toBeVisible()
  const raven = page.getByTestId('raven-slice-glide')
  await expect(raven).toBeVisible({ timeout: 5_000 })
  const running = await block.boundingBox()
  expect(Math.abs((running?.height ?? 0) - (idle?.height ?? 0))).toBeLessThanOrEqual(1)
  const r = (await raven.boundingBox())!
  const t = (await track.boundingBox())!
  // Inside the track, so above it is only the line of text, which it never reaches.
  expect(r.y).toBeGreaterThanOrEqual(t.y - 0.5)
  expect(r.y + r.height).toBeLessThanOrEqual(t.y + t.height + 0.5)
  for (const text of await block.locator('p').all()) {
    const b = await text.boundingBox()
    if (!b) continue
    const overlaps = r.x < b.x + b.width && b.x < r.x + r.width && r.y < b.y + b.height && b.y < r.y + r.height
    expect(overlaps).toBe(false)
  }
  // And back: the slice ends, the button comes back in the same place.
  await patch(page, { slice: { status: 'idle' } })
  await expect(track).toHaveCount(0)
  const after = await block.boundingBox()
  expect(Math.abs((after?.height ?? 0) - (idle?.height ?? 0))).toBeLessThanOrEqual(1)
})

// ---- Copies ----

test('four arranged copies slice to an estimate', async ({ page }) => {
  test.slow()
  await calm(page)
  await patch(page, { overrides: {}, slotSetup: {}, slice: { status: 'idle' } })
  await layeredX(page)
  const read = async () => {
    const s = await state(page)
    return { n: s.plate.length, status: s.slice.status, stale: s.slice.stale ?? false, id: s.slice.result?.id ?? null, message: s.slice.message ?? null }
  }
  try {
    // Always: Auto would hold a plate whose last slice took as long as a test runner's.
    await patch(page, { autoSlice: true, autoSliceBySize: false })
    await nudge(page, 1)
    await expect.poll(async () => (await read()).status, { timeout: 120_000 }).toBe('done')
    const single = (await read()).id
    await page.locator('.obj-name', { hasText: 'Layered X' }).first().click()
    for (let i = 0; i < 3; i++) await command(page, 'Add an instance of the selected object')
    await command(page, 'Arrange all objects')
    expect((await read()).n).toBe(4)
    // Two filaments, so the plate slices as one: its automatic brim must still be each object's own. Sized for the
    // whole plate it runs off the bed, and the safety preflight blocks the slice. The slice of the four, not the one before.
    await expect.poll(async () => { const s = await read(); return (s.status === 'done' && !s.stale && s.id !== single) || s.status === 'error' }, { timeout: 120_000 }).toBe(true)
    expect((await read()).message).toBeNull()
    await expect(page.getByRole('button', { name: /^Print( on .+)?$/ })).toBeEnabled()
  } finally {
    await patch(page, { autoSlice: false })
  }
})

// ---- The Slice footer's estimate ----

test('after a slice the footer reads time and grams on one line, and the time opens the breakdown', async ({ page }) => {
  test.slow()
  await calm(page, 'simple')
  await patch(page, { overrides: {}, slotSetup: {}, slice: { status: 'idle' } })
  await boxOnPlate(page)
  // The footer before any slice, then the slice from its own button.
  const foot = page.getByTestId('slice-estimate')
  await expect(foot).toContainText('Slice to see time, filament and cost.')
  const n = await sliceCount(page)
  await page.getByTestId('slice-estimate-slice').click()
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
  await remember(page)
  await expect(page.getByTestId('slice-estimate-time')).toHaveText(/^(\d+h )?\d+m$/)
  await expect(foot.locator('.est-fig').first()).toHaveText(/^\d+(\.\d)? g$/)
  await expect(page.getByTestId('slice-estimate-warnings')).toHaveCount(0)
  await page.getByTestId('slice-estimate-time').click()
  const breakdown = page.getByTestId('slice-estimate-breakdown')
  await expect(breakdown).toBeVisible()
  await expect(breakdown).toContainText('Where the time goes')
  await expect(breakdown.locator('.est-slots li').first()).toContainText('Slot 1')
  await page.keyboard.press('Escape')
  await expect(breakdown).toHaveCount(0)
  // The warnings chip (hidden at zero, counted otherwise) is estimate-line.test.ts:18.
})

test('Print is a split button: its menu has the exports, and an edit marks the estimate stale', async ({ page }) => {
  test.slow()
  await sliceBox(page, { mode: 'simple' })
  await expect(page.getByTestId('danger-slice-print')).toBeEnabled()
  // It names the printer it prints on, on one line.
  await expect(page.getByTestId('danger-slice-print')).toHaveAccessibleName(/^Print on .+/)
  expect((await page.getByTestId('danger-slice-print').boundingBox())!.height).toBeLessThan(60)
  await page.getByTestId('slice-output-menu').click()
  await expect(page.getByTestId('slice-output-export-gcode')).toBeVisible()
  await expect(page.getByTestId('slice-output-export-3mf')).toBeVisible()
  await page.keyboard.press('Escape')
  // A setting change makes the slice stale: the tag says so and the main action is Slice again.
  const supports = page.getByRole('radiogroup', { name: 'Supports' })
  const was = (await supports.getByRole('radio', { checked: true }).textContent())?.trim() ?? 'Off'
  const other = was === 'Auto' ? 'Off' : 'Auto'
  try {
    await supports.getByRole('radio', { name: other }).click()
    await expect(page.getByTestId('slice-estimate')).toHaveAttribute('data-stale', 'true')
    await expect(page.getByTestId('slice-estimate')).toContainText('Settings changed')
    await expect(page.getByTestId('slice-estimate-slice')).toBeVisible()
  } finally {
    await supports.getByRole('radio', { name: was }).click()
  }
})

test('a printer with no connection exports G-code as the main action', async ({ page }) => {
  test.slow()
  await calm(page, 'simple')
  try {
    await handPrinter(page, A1_MINI)
    await patch(page, { overrides: {}, slotSetup: {}, slice: { status: 'idle' } })
    await boxOnPlate(page)
    const n = await sliceCount(page)
    await page.getByTestId('slice-estimate-slice').click()
    await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('slice-estimate-export-gcode')).toHaveText('Export G-code')
    await expect(page.getByTestId('danger-slice-print')).toHaveCount(0)
  } finally {
    await handPrinter(page, null)
  }
})

// ---- What the plate sends to the engine ----

const stepFixtures = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'app', 'test', 'fixtures', 'step')

async function drop(page: Page, name: string): Promise<void> {
  const bytes = [...readFileSync(join(stepFixtures, name))]
  await page.evaluate(({ name, bytes }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/step' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { name, bytes })
}

// The slice this click starts: done, current and with a new id, so an earlier slice of the plate does not pass for it.
async function sliceDone(page: Page): Promise<void> {
  const before = (await state(page)).slice.result?.id ?? null
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect
    .poll(async () => {
      const sl = (await state(page)).slice
      if (sl.status === 'error') return JSON.stringify(sl).slice(0, 600)
      return sl.status === 'done' && !sl.stale && sl.result?.id !== before ? 'done' : sl.status
    }, { timeout: 120_000 })
    .toBe('done')
}

test('objects arranged with a brim slice without the bed check blocking them', async ({ page }) => {
  test.slow()
  await calm(page)
  await patch(page, { overrides: {}, slotSetup: {}, plate: [], selection: null, selectedIds: [], slice: { status: 'idle' } })
  // Several objects from one file, then one more: the arrange packs them with their brims.
  await drop(page, 'assembly.step')
  await expect.poll(async () => (await state(page)).plate.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
  const n = (await state(page)).plate.length
  await command(page, 'Add a cylinder')
  await expect.poll(async () => (await state(page)).plate.length).toBe(n + 1)
  const brim = page.locator('#easy-brim')
  await brim.scrollIntoViewIfNeeded()
  const brimWas = (await brim.getAttribute('aria-checked')) === 'true'
  if (!brimWas) await brim.click()
  try {
    await expect(brim).toHaveAttribute('aria-checked', 'true')
    await command(page, 'Arrange all objects')
    await sliceDone(page)
    await expect(page.getByText(/past the bed|outside the bed|off the bed/i)).toHaveCount(0)
  } finally {
    if (!brimWas) await brim.click()
  }
})

/** The tools the first layer changes to, in order, from exported G-code. */
function firstLayerTools(gcode: string): string[] {
  const marksAt = [...gcode.matchAll(/^;\s*(?:LAYER_CHANGE|CHANGE_LAYER)\b/gm)].map((m) => m.index!)
  if (marksAt.length < 2) throw new Error(`no layer marks in the G-code (${marksAt.length})`)
  return [...gcode.slice(marksAt[0], marksAt[1]).matchAll(/^\s*(T\d+)\b/gm)].map((m) => m[1]!)
}

test('a two-color plate keeps its prime tower and the filament order reaches the G-code', async ({ page }) => {
  test.slow()
  await calm(page)
  await keep(page, 'plates')
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  await patch(page, { overrides: {}, slotSetup: {}, slice: { status: 'idle' } })
  await page.getByTestId('slice-machine-printer').click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: /Bay 2/ }).click()
  const exportGcode = async (): Promise<string> => {
    await sliceDone(page)
    await expect(sliced(page)).toBeVisible()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
    const text = readFileSync(await download.path(), 'utf8')
    await tab(page, 'prepare').click()
    return text
  }
  try {
    // A box on filament 1 and a cylinder on filament 2: both print on every layer.
    await patch(page, { plate: [], selection: null, selectedIds: [] })
    await command(page, 'Add a box')
    await command(page, 'Add a cylinder')
    await expect.poll(async () => (await state(page)).plate.length).toBe(2)
    const cylinder = page.locator('li.obj').nth(1)
    await setPartFilament(page, cylinder, 2)
    const plain = await exportGcode()
    expect(plain).toMatch(/;\s*(?:TYPE|FEATURE):\s*Prime tower/i)
    const before = firstLayerTools(plain)

    // Slot 1 first by default: the first layer ends on filament 2. Slot 2 first: it ends on filament 1.
    expect(before.at(-1)).toBe('T1')
    await (await plateSheet(page)).getByRole('button', { name: 'Plate settings' }).click()
    const order = page.getByRole('list', { name: 'Filament order' })
    await expect(order).toBeVisible()
    await order.getByRole('button', { name: 'Print slot 2 earlier' }).click()
    await expect(order.locator('li').first()).toContainText('Slot 2')
    await page.getByRole('group', { name: /settings$/ }).getByRole('button', { name: 'Done' }).click()
    await shutPlateSheet(page)
    const swapped = await exportGcode()
    expect(swapped).toMatch(/;\s*(?:TYPE|FEATURE):\s*Prime tower/i)
    const after = firstLayerTools(swapped)
    expect(after).not.toEqual(before)
    expect(after.at(-1)).toBe('T0')
    expect(after.indexOf('T1')).toBeLessThan(after.lastIndexOf('T0'))
  } finally {
    await restore(page)
  }
})

// ---- The layer and move sliders ----

/** The segment range the viewport draws right now, read from the toolpath layer. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const tp = (window as unknown as { __vp: { toolpaths: { visibleRange(): [number, number]; hi: number } } }).__vp.toolpaths
    const [from, to] = tp.visibleRange()
    return { from, to, hi: tp.hi }
  })

// The jump key and the typed layer or height (Shift+G, "3", "0.01 mm", a word refused) are layer-step.test.ts:63-82 and
// plate-keys.test.ts:140, and the slider's arrow and page keys are layer-step.test.ts:39 and plate-keys.test.ts:63.

test('the layer slider moves the top drawn layer', async ({ page }) => {
  await sliceBox(page)
  const layer = page.locator('#pv-layer')
  const full = await drawn(page)
  await layer.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => (await drawn(page)).hi).toBe(0)
  const first = await drawn(page)
  expect(first.to).toBeLessThan(full.to)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await drawn(page)).hi).toBe(2)
  await page.keyboard.press('End')
  await expect.poll(async () => (await drawn(page)).to).toBe(full.to)
})

test('the move slider cuts the top layer and shows the nozzle there', async ({ page }) => {
  await sliceBox(page)
  await page.locator('#pv-layer').focus()
  await page.keyboard.press('ArrowLeft')
  const layerEnd = (await drawn(page)).to
  const moves = page.locator('#pv-moves')
  await moves.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => (await drawn(page)).to).toBeLessThan(layerEnd)
  const start = (await drawn(page)).to
  await page.keyboard.press('PageUp')
  await expect.poll(async () => (await drawn(page)).to).toBeGreaterThan(start)
})

test('dragging the sliders with the mouse scrubs layers and moves', async ({ page }) => {
  await sliceBox(page)
  const layer = page.locator('#pv-layer')
  const n = Number(await layer.getAttribute('max'))
  // The dock can still be settling after the slice (under load the side pane lands late), so each press goes
  // through the locator, which waits for the slider to be stable and uncovered, and each drag measures it again.
  const at = async (slider: typeof layer, share: number) => {
    const b = (await slider.boundingBox())!
    return { x: b.width * share, y: b.height / 2, abs: [b.x + b.width * share, b.y + b.height / 2] as const }
  }
  // Grab the thumb at the right end and drag to the middle.
  const end = await at(layer, 1)
  await layer.hover({ position: { x: end.x - 4, y: end.y } })
  await page.mouse.down()
  const mid = await at(layer, 0.5)
  await page.mouse.move(...mid.abs, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Math.abs((await drawn(page)).hi + 1 - n / 2), { timeout: 10_000 }).toBeLessThan(n * 0.12)
  // Clicking the track jumps there.
  const quarter = await at(layer, 0.25)
  await layer.click({ position: { x: quarter.x, y: quarter.y } })
  await expect.poll(async () => Math.abs((await drawn(page)).hi + 1 - n / 4), { timeout: 10_000 }).toBeLessThan(n * 0.12)
  const moves = page.locator('#pv-moves')
  const half = await at(moves, 0.5)
  await moves.click({ position: { x: half.x, y: half.y } })
  const before = (await drawn(page)).to
  await moves.hover({ position: { x: half.x, y: half.y } })
  await page.mouse.down()
  const far = await at(moves, 0.85)
  await page.mouse.move(...far.abs, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await drawn(page)).to, { timeout: 10_000 }).toBeGreaterThan(before)
})

// Playing at 100 times waits on real frames, which a slow runner stretches: nightly.
test('the playback bar plays, pauses and scrubs by time', { tag: '@nightly' }, async ({ page }) => {
  await sliceBox(page)
  const dock = page.getByRole('group', { name: 'Layers and moves' })
  const time = page.locator('#pv-time')
  const total = Number(await time.getAttribute('max'))
  expect(total).toBeGreaterThan(60)
  // Scrubbing the time slider lands on a matching layer and puts the toolhead at the cut.
  await time.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => (await drawn(page)).hi).toBe(0)
  // Tool changes get a set share of the track (CHANGE_SHARE), so half the print time is not half the track. Ask the app where half the time sits.
  const half = await page.evaluate((t) => (window as unknown as { __pv: { track(time: number): number } }).__pv.track(t / 2), total)
  await page.locator('#pv-time').evaluate((el: HTMLInputElement, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, Math.round(half))
  const layers = await layerCount(page)
  await expect.poll(async () => (await drawn(page)).hi).toBeGreaterThan(Math.min(5, layers / 4))
  const mid = await page.evaluate(() => (window as unknown as { __vp: { toolpaths: { head: { visible: boolean } } } }).__vp.toolpaths.head.visible)
  expect(mid).toBe(true)
  // Play from the start, see it advance, then pause. 100 times, the fastest speed.
  // the speeds are a segmented control on a wide bar, and one menu button on a folded one (the side panes open)
  const seg = dock.getByRole('radio', { name: '100 times real time' })
  if (await seg.isVisible()) await seg.click()
  else {
    await dock.getByRole('button', { name: /^Playback speed/ }).click()
    await page.getByRole('menuitemcheckbox', { name: '100x' }).click()
    await expect(dock.getByRole('button', { name: 'Playback speed 100x' })).toBeVisible()
  }
  await time.focus()
  await page.keyboard.press('Home')
  await dock.getByRole('button', { name: 'Play print' }).click()
  await expect(dock.getByRole('button', { name: 'Pause playback' })).toBeVisible()
  await expect.poll(async () => (await drawn(page)).hi, { timeout: 20_000 }).toBeGreaterThan(3)
  await dock.getByRole('button', { name: 'Pause playback' }).click()
  // Pause stops the playback at once: the time slider holds its value.
  const held = await time.inputValue()
  await page.waitForTimeout(800)
  expect(await time.inputValue()).toBe(held)
  // The viewport then settles on the paused range: it stops changing across three polls in a row.
  let last = (await drawn(page)).to
  let still = 0
  await expect
    .poll(async () => {
      const now = (await drawn(page)).to
      still = now === last ? still + 1 : 0
      last = now
      return still >= 3
    }, { intervals: [300], timeout: 15_000 })
    .toBe(true)
  await expect(dock.getByRole('button', { name: 'Play print' })).toBeVisible()
})

// ---- Print by object ----

test('heimdall strikes a plate too close to print by object, and printing by layer clears it', async ({ page }) => {
  test.slow()
  await calm(page)
  await keep(page, 'plates')
  type Seq = { plates: { id: string; settings: Record<string, unknown> }[] }
  const sx = async () => {
    const s = await state(page)
    return { n: s.plate.length, layers: s.workspace === 'prepare' && s.modelMode === 'slice' && s.sliceLook === 'toolpaths' && s.preview !== null, status: s.slice.status, stale: s.slice.stale ?? false, id: s.slice.result?.id ?? null, collisions: s.slice.result?.collisions ?? [], layerHi: s.layerHi, pick: s.strikePick }
  }
  await patch(page, { overrides: {}, slotSetup: {}, slice: { status: 'idle' }, plate: [], selection: null, selectedIds: [] })
  try {
    for (const n of [1, 2]) {
      await command(page, 'Add a box')
      await expect.poll(async () => (await sx()).n).toBe(n)
    }
    await patch(page, { autoSlice: false })
    await command(page, 'Arrange all objects')
    const print = page.getByRole('button', { name: /^Print( on .+)?$/ })
    await startSlice(page)
    await expect.poll(async () => { const s = await sx(); return s.status === 'done' && !s.stale }, { timeout: 120_000 }).toBe(true)
    await expect(print).toBeEnabled()

    // By object the boxes stand inside the toolhead's reach: the slice runs and heimdall strikes it. The sequence change
    // starts a background slice, and it settles first: a command slice still running when the test moves on would
    // finish later and show its toolpaths again.
    await patch(page, { autoSlice: true, autoSliceBySize: false })
    await page.evaluate(() => {
      const st = (window as unknown as { __sx: { getState(): Seq & Snap; setState(p: unknown): void } }).__sx
      const s = st.getState()
      st.setState({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, sequence: 'by-object' } } : p)) })
    })
    await expect.poll(async () => { const s = await sx(); return s.status === 'done' && !s.stale && s.collisions.some((c) => c.severity === 'hit') }, { timeout: 120_000 }).toBe(true)
    await patch(page, { autoSlice: false })
    const background = (await sx()).id
    await command(page, 'Slice the plate')
    // The command's own slice is done once its result replaces the background one and Slice shows its toolpaths (there
    // is no Preview workspace any more: the command shows the slice in Slice).
    await expect.poll(async () => { const s = await sx(); return s.layers && s.status === 'done' && !s.stale && s.id !== background && s.collisions.some((c) => c.severity === 'hit') }, { timeout: 120_000 }).toBe(true)
    await expect(page.getByRole('alert').filter({ hasText: 'heimdall found' }).first()).toBeVisible()
    await patch(page, { workspace: 'prepare' })
    await expect(print).toBeDisabled()

    // Slice's summary lists the strikes, marks them on the layer slider, and offers the fixes.
    await patch(page, { workspace: 'prepare', sliceLook: 'toolpaths' })
    const list = page.locator('[data-section="collisions"]')
    await expect(list).toBeVisible()
    await expect(list.locator('.strike-tag')).toContainText(/strikes? on this plate/)
    const first = list.locator('.strikes li').first()
    await expect(first).toContainText(/hits/)
    await expect(first.locator('.sx-ic')).toBeVisible()
    await expect(page.locator('.layer-mark.strike-mark').first()).toBeVisible()
    // A click on the strike's row selects the two boxes it names.
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ selection: null, selectedIds: [] }))
    await first.getByTestId('collision-select').click()
    await expect(first.getByTestId('collision-select')).toHaveAttribute('aria-pressed', 'true')
    expect((await state(page)).selectedIds).toHaveLength(2)
    await first.getByRole('button', { name: /^Jump to:/ }).click()
    const { collisions } = await sx()
    await expect.poll(async () => (await sx()).pick).toBe(0)
    // Playback runs up to the strike and stops on its layer.
    await expect.poll(async () => (await sx()).layerHi).toBe((collisions[0]?.layer ?? 0) + 1)

    // Print by layer clears it in one click.
    const byLayer = list.locator('.strike-fixes li', { hasText: 'Print by layer' })
    await expect(byLayer).toBeVisible()
    await patch(page, { autoSlice: true, autoSliceBySize: false })
    await byLayer.getByRole('button', { name: 'Apply' }).click()
    await expect.poll(async () => { const s = await sx(); return s.status === 'done' && !s.stale && s.collisions.length === 0 }, { timeout: 120_000 }).toBe(true)
    await expect(list).toHaveCount(0)
    await patch(page, { workspace: 'prepare' })
    await expect(print).toBeEnabled()
  } finally {
    await patch(page, { autoSlice: false })
    await restore(page)
  }
})

// ---- One print time everywhere ----

/** The estimate's figure as the app words it (42m, 1h 05m is shown as 1h 5m). */
const worded = (s: number): string => {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h === 0 ? `${m}m` : `${h}h ${m}m`
}

/** 41:44 for short prints, 1:05:09 for long ones. */
const clocked = (s: number): string => {
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const two = (v: number) => String(v).padStart(2, '0')
  return h > 0 ? `${h}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}` : `${Math.floor(t / 60)}:${two(t % 60)}`
}

test('the estimate, the summary, the playback bar and the send sheet show one print time', async ({ page }) => {
  test.slow()
  await calm(page)
  await patch(page, { overrides: {}, slotSetup: {}, slice: { status: 'idle' } })
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  // Layered X: the figure under test is its estimate, with the start before the first layer and its tool changes.
  await layeredX(page)
  await startSlice(page)
  await expect(page.getByRole('group', { name: 'Layers and moves' })).toBeVisible()

  const stats = (await state(page)).slice.result?.stats
  expect(stats?.timeS).toBeGreaterThan(60)
  const timeS = stats!.timeS
  // The slice reports the start before the first layer, and it is part of the figure.
  expect(stats!.prepareS ?? 0).toBeGreaterThan(0)
  expect(stats!.prepareS!).toBeLessThan(timeS)

  // Preview summary: the headline and the rows (the start included) add up to the estimate.
  const block = page.locator('[data-section="time"]')
  await expect(block.locator('.est-time')).toHaveText(worded(timeS))
  await expect(block.locator('.tlist li', { hasText: 'Heating, homing and purge' })).toHaveCount(1)
  const rows = await block.locator('.tlist li em').allInnerTexts()
  const share = rows.reduce((a, t) => a + (t.startsWith('<') ? 0.5 : Number.parseInt(t, 10)), 0)
  expect(share).toBeGreaterThan(95)
  expect(share).toBeLessThan(105)

  // Playback bar: the Time slider runs to the estimate.
  await expect(page.locator('#pv-time')).toHaveAttribute('aria-valuetext', new RegExp(` of ${clocked(timeS)}$`))
  await expect(page.locator('output[for="pv-time"]')).toContainText(`/ ${clocked(timeS)}`)
  // The head is still at the start with the bed empty until the first layer begins.
  await page.locator('#pv-time').focus()
  await page.keyboard.press('Home')
  await expect(page.locator('#pv-time')).toHaveAttribute('aria-valuetext', new RegExp(`^0:00 of ${clocked(timeS)}$`))
  await page.keyboard.press('End')
  await expect(page.locator('#pv-time')).toHaveAttribute('aria-valuetext', new RegExp(`^${clocked(timeS)} of ${clocked(timeS)}$`))

  // Model estimate.
  await tab(page, 'prepare').click()
  await expect(page.locator('[data-section="estimate"] .est-time')).toHaveText(worded(timeS))

  // Send sheet.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Print the plate on')
  const item = page.locator('.sx-palette-item', { hasText: 'Print the plate on' }).first()
  await expect(item).toBeVisible()
  await item.click()
  const sheet = page.locator('dialog.print-sheet[open]')
  // The sheet's summary of what will print (bcdbb995 replaced its Estimate group) carries the same time.
  await expect(sheet.getByRole('region', { name: 'What will print' })).toContainText(worded(timeS))
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})

// ---- The right pane ----

test.describe('the right pane', () => {
  const edge = (page: Page) => page.getByTestId('edge-tab-right')
  // A toast that stays until dismissed (a slice's warning, say) can sit over the tab.
  const press = async (page: Page) => {
    await clearToasts(page)
    await edge(page).click()
  }

  /** Slice's right pane as a new session has it: shut, and not shut by hand. */
  async function shutPane(page: Page): Promise<void> {
    await calm(page, 'simple')
    await page.evaluate(() => {
      sessionStorage.setItem('sx-right-pane', 'shut')
      const sx = (window as unknown as { __sx: { getState(): Snap; setState(p: unknown): void } }).__sx
      sx.setState({ rails: { ...sx.getState().rails, preview: undefined }, rightShut: null })
    })
  }

  async function slice(page: Page): Promise<void> {
    const n = await sliceCount(page)
    await page.mouse.click(700, 450)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
  }

  // Not kept between sessions (slice-panes.test.ts:49), and the glow for a slice with warnings (right-attention.test.ts:19)
  // are unit tested.
  test('starts shut, a finished slice leaves it shut, and its tab opens it with the summary', async ({ page }) => {
    await sliceBox(page, { mode: 'simple' })
    await shutPane(page)
    await expect(edge(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('slice-summary')).toHaveCount(0)
    await slice(page)
    await expect(edge(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('slice-summary')).toHaveCount(0)
    // The time, filament and cost stay on screen in the left pane's foot.
    await expect(page.getByTestId('slice-estimate-time')).toBeVisible()
    await press(page)
    await expect(edge(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('slice-summary')).toBeVisible()
    await expect(edge(page)).not.toHaveAttribute('data-attention', /./)
  })

  test('opened by hand, it stays open through the slices until shut, by the tab or its key', async ({ page }) => {
    await sliceBox(page, { mode: 'simple' })
    await shutPane(page)
    await press(page)
    await expect(edge(page)).toHaveAttribute('aria-expanded', 'true')
    await slice(page)
    await expect(edge(page)).toHaveAttribute('aria-expanded', 'true')
    await page.mouse.move(700, 300)
    await page.keyboard.press('BracketRight')
    await expect(edge(page)).toHaveAttribute('aria-expanded', 'false')
    await slice(page)
    await expect(edge(page)).toHaveAttribute('aria-expanded', 'false')
  })

  const offBed = (page: Page) =>
    page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): Snap; setState(p: unknown): void } }).__sx
      const [o, ...rest] = sx.getState().plate
      const t = [...o!.transform]
      t[12] = 900
      sx.setState({ plate: [{ ...o, transform: t }, ...rest] })
    })

  test('shut, it glows for an object off the bed, and under reduced motion the glow is still, not breathing', async ({ page }) => {
    await sliceBox(page, { mode: 'simple' })
    await shutPane(page)
    const motion = (await state(page))['motion']
    try {
      await offBed(page)
      await expect(edge(page)).toHaveAttribute('data-attention', 'true')
      await patch(page, { motion: 'reduced' })
      expect(await edge(page).evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    } finally {
      await patch(page, { motion })
    }
  })

  test('a 120-character file name stays on one line in the objects list and Print, and the plate chip names the plate only', async ({ page }) => {
    test.slow()
    await calm(page, 'simple')
    const long = `${'Very_long_model_name_from_a_marketplace_download_'.repeat(2)}with_extras_v2_final.stl`.slice(-120)
    const printer = { id: 'e2e-long', name: 'H2D 0.4 from CHAINSAW_MAN_-_POCHITA_-_KEYCHAIN_WITH_A_VERY_LONG_PROJECT_NAME', profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }
    try {
      await handPrinter(page, printer)
      await patch(page, { overrides: {}, slotSetup: {}, slice: { status: 'idle' } })
      await boxOnPlate(page)
      await page.evaluate((name) => {
        const sx = (window as unknown as { __sx: { getState(): Snap; setState(p: unknown): void } }).__sx
        const [o, ...rest] = sx.getState().plate
        sx.setState({ plate: [{ ...o, name }, ...rest], autoSlice: true, autoSliceBySize: false })
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
      // The plate picker names the plate, not the object, and the view has no size chip: the scale tool has the size.
      await expect(page.getByTestId('plate-picker-current')).toContainText('Plate 1')
      await expect(page.getByTestId('plate-picker-current')).not.toContainText('CHAINSAW')
      await expect(page.locator('.vp .dims')).toHaveCount(0)
      // The export-only printer's footer action and the summary's Export name the printer without its project.
      await expect(page.getByTestId('slice-machine-printer')).toContainText('H2D 0.4')
      await expect(page.getByTestId('slice-machine-printer')).not.toContainText('CHAINSAW')
      // After the slice, the summary's Export names the printer the same way, inside its button.
      const exportBtn = page.getByTestId('slice-summary').getByRole('button', { name: /^Export for H2D 0\.4/ })
      await expect(exportBtn).toBeVisible({ timeout: 120_000 })
      expect(await inside('[data-testid="slice-summary"] .btn-name')).toEqual({ oneLine: true, fits: true })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    } finally {
      await patch(page, { autoSlice: false })
      await handPrinter(page, null)
    }
  })
})

// ---- Show me on a block ----

/** What Show me drew on the plate: the strike marks (bed frame) and the outlined area's lines. */
const spotMarks = (page: Page) =>
  page.evaluate(() => {
    type Node = { name: string; type: string; visible: boolean; position: { x: number; y: number }; children: Node[]; parent: Node | null }
    const root = (window as unknown as { __vp: { stage: { objectsRoot: Node } } }).__vp.stage.objectsRoot
    const marked: number[][] = []
    let area = 0
    const walk = (n: Node) => {
      if (n.type === 'Sprite' && n.name.startsWith('strike')) marked.push([n.position.x, n.position.y])
      if (n.name === 'strike area') area = n.children.filter((c) => c.type === 'Line').length
      n.children.forEach(walk)
    }
    walk(root)
    return { shown: root.visible, marks: marked, area }
  })
const target = (page: Page) => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.getCamera().target)
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 0.5)

/** A gantry strike on layer 3 (0 based), deepest at 120, 110, 8 mm, put on the finished slice. */
async function strike(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): Snap; setState(p: unknown): void } }).__sx
    const s = sx.getState()
    const id = s.plate[0]!.id
    // Its moment is the middle of layer 3, so playback stops on the strike's own layer.
    const lt = s.slice.result!.layerTimeS!
    const timeS = lt[0]! + lt[1]! + lt[2]! + lt[3]! / 2
    const hit = { kind: 'gantry', severity: 'hit', part: 'gantry', objectId: id, hitId: id, layer: 3, segment: 0, timeS, lastLayer: 4, at: [120, 110, 0.8], point: [120, 110, 8], worstLayer: 3, worstPoint: [120, 110, 8], depthMm: 2, hitHeightMm: 12, limitMm: 10 }
    sx.setState({ slice: { ...s.slice, result: { ...s.slice.result, collisions: [hit], collisionFixes: [] } } })
  })
}

/** An excluded area of 20 mm around the first object's place, so the safety check refuses the plate's next slice. */
async function refuse(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): Snap; setState(p: unknown): void } }).__sx
    const s = sx.getState()
    const t = s.plate[0]!.transform
    const [x, y] = [t[12]!, t[13]!]
    const c = (dx: number, dy: number) => `${(x + dx).toFixed(1)}x${(y + dy).toFixed(1)}`
    sx.setState({ overrides: { ...s.overrides, bed_exclude_area: [c(-10, -10), c(10, -10), c(10, 10), c(-10, 10)] } })
  })
  await command(page, 'Slice the plate')
  await expect(page.getByTestId('slice-estimate-error')).toBeVisible({ timeout: 120_000 })
}

test('Show me on a strike opens the toolpaths at its layer and the collision list, with its part selected', async ({ page }) => {
  await sliceBox(page, { mode: 'simple' })
  await patch(page, { sliceLook: 'solid' })
  await strike(page)
  // The person shut the summary pane: the strike alone does not open it.
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): Snap & { rails: Record<string, unknown>; jobSeq: number }; setState(p: unknown): void } }).__sx
    const s = sx.getState()
    sx.setState({ rails: { ...s.rails, preview: { left: false, right: false } }, rightShut: s.jobSeq })
  })
  const list = page.locator('[data-section="collisions"]')
  await expect(list).toBeHidden()
  const show = page.getByTestId('slice-block-show')
  await expect(show).toHaveText('Show me')
  await show.click()
  await expect.poll(async () => { const s = await state(page); return `${s.sliceLook} ${s.layerHi} ${s.strikePick}` }).toBe('toolpaths 4 0')
  await expect(list).toBeVisible()
  const s = await state(page)
  expect(s.selectedIds).toEqual([s.plate[0]!.id])
  // Its row reads as pressed while the part is the selection.
  await expect(list.getByTestId('collision-select').first()).toHaveAttribute('aria-pressed', 'true')
})

// The frame by frame readout: every layer the bar shows from the click on is the strike's first layer, never the layer
// below while the playback runs up to the strike. It samples every animation frame and waits for the playback: nightly.
test('Show me on a strike never shows the layer below while the playback runs up to it', { tag: '@nightly' }, async ({ page }) => {
  await sliceBox(page, { mode: 'simple' })
  await patch(page, { sliceLook: 'solid' })
  await strike(page)
  const show = page.getByTestId('slice-block-show')
  await expect(show).toHaveText('Show me')
  await page.evaluate(() => {
    const w = window as unknown as { __seen: Set<string>; __sampling: boolean; __sx: { getState(): Snap } }
    w.__seen = new Set<string>()
    w.__sampling = true
    // samples until the test stops it, so a slow machine can't run the window out before the jump lands; the
    // deadline only keeps a stuck test from sampling forever
    const t0 = performance.now()
    const tick = () => {
      const v = document.querySelector('#pv-layer')?.getAttribute('aria-valuetext')
      // From the click on: the jump has picked the strike, before that the bar shows the whole print.
      if (v && w.__sx.getState().strikePick !== null) w.__seen.add(v.replace(/ of .*/, ''))
      if (w.__sampling && performance.now() - t0 < 15_000) requestAnimationFrame(tick)
    }
    tick()
  })
  await show.click()
  await expect.poll(async () => { const s = await state(page); return `${s.sliceLook} ${s.layerHi} ${s.strikePick}` }).toBe('toolpaths 4 0')
  await page.waitForTimeout(3500)
  const seen = await page.evaluate(() => {
    const w = window as unknown as { __seen: Set<string>; __sampling: boolean }
    w.__sampling = false
    return [...w.__seen]
  })
  expect(seen).toEqual(['Layer 4'])
  expect((await state(page)).layerHi).toBe(4)
})

test('Show me on a refused slice centers the view on the spot the refusal names', async ({ page }) => {
  test.slow()
  await sliceBox(page, { mode: 'simple' })
  await refuse(page)
  const text = (await page.getByTestId('slice-estimate-error').textContent()) ?? ''
  const m = /from layer (\d+) \(X(-?[\d.]+) Y(-?[\d.]+)/.exec(text)
  expect(m, text).not.toBeNull()
  const before = await target(page)
  await page.getByTestId('slice-error-show').click()
  // The example plate's printer counts from 0, 0, so the machine X and Y are the plate's; layer 1 is the bed.
  const spot = [Number(m![2]), Number(m![3]), 0]
  expect(near(before, spot)).toBe(false)
  await expect.poll(async () => near(await target(page), spot)).toBe(true)
  const s = await state(page)
  expect(s.selectedIds.map((id) => s.plate.find((p) => p.id === id)?.name)).toEqual([s.plate[0]!.name])
  // The camera turn alone does not read as "here": the spot carries the strike mark, and the excluded area it enters
  // is outlined. Both go when the refusal does.
  expect(text).toMatch(/^[A-Z]/)
  const marked = await spotMarks(page)
  expect(marked.shown).toBe(true)
  expect(marked.marks).toHaveLength(1)
  expect(near(marked.marks[0]!, spot)).toBe(true)
  expect(marked.area).toBe(3)
  await patch(page, { slice: { status: 'idle' } })
  expect(await spotMarks(page)).toMatchObject({ marks: [], area: 0 })
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: Show me on the Slice footer blocks, light and dark', async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await sliceBox(page, { mode: 'simple' })
  const shot = async (name: string, settle = 900) => {
    await page.mouse.move(0, 0)
    await page.waitForTimeout(settle)
    // The test build's own notices (software WebGL, no geometry engine) would cover the view.
    await patch(page, { toast: null })
    await page.waitForTimeout(300)
    await patch(page, { toast: null })
    await page.waitForTimeout(100)
    await page.screenshot({ path: `${dir}/${name}-${width}.png` })
  }
  const zoomToBed = () => page.evaluate(() => (window as unknown as { __vp: { zoomToBed?(o: unknown): void } }).__vp.zoomToBed?.({ animate: false }))
  for (const scheme of ['light', 'dark'] as const) {
    await patch(page, { scheme, themeFollowsSystem: false, sliceLook: 'solid', layerHi: 1e9 })
    await strike(page)
    await expect(page.getByTestId('slice-block-show')).toBeVisible()
    await zoomToBed()
    await shot(`strike-before-${scheme}`)
    await page.getByTestId('slice-block-show').click()
    await shot(`strike-after-${scheme}`, 3000)
  }
  await refuse(page)
  for (const scheme of ['light', 'dark'] as const) {
    await patch(page, { scheme, themeFollowsSystem: false, selectedIds: [], selection: null })
    await zoomToBed()
    await shot(`refused-before-${scheme}`)
    await page.getByTestId('slice-error-show').click()
    await shot(`refused-after-${scheme}`)
    // Close in on the spot, to judge the outline of the excluded area under the mark.
    await page.evaluate(() => (window as unknown as { __vp: { zoomBy?(f: number, o: unknown): void } }).__vp.zoomBy?.(4, { animate: false }))
    await shot(`refused-after-zoom-${scheme}`)
  }
})

// ---- The Slice tab as people first see it ----

test.describe('Slice tab defaults', () => {
  test('the bar keeps its controls on one row while it is folded, or transport and speed over the view checks and readout when wide, and its tab never meets the plate chip', async ({ page }) => {
    await sliceBox(page, { mode: 'simple' })
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(size)
      if (size.width === 1440) {
        // Both panes open: the narrowest view at this width.
        await expect(page.getByTestId('edge-tab-right')).toHaveAttribute('aria-expanded', 'true')
      }
      const dock = page.getByTestId('preview-drawer')
      const edgeTab = dock.getByTestId('edge-tab-bottom')
      for (const want of ['slim', 'full'] as const) {
        if ((await dock.getAttribute('data-mode')) !== want) await edgeTab.click()
        await expect(dock).toHaveAttribute('data-mode', want)
        await page.waitForTimeout(250)
        const mid = async (sel: string) => { const b = (await dock.locator(sel).first().boundingBox())!; return b.y + b.height / 2 }
        // under 1000 px (both side panes open) the bar folds to one row: the speed as one button, the checks as icons
        const folded = (await dock.getAttribute('data-narrow')) !== null
        const play = await mid('button[aria-label="Play print"]')
        const speed = await mid(folded ? '.dock-speed-btn' : '[role="radiogroup"]')
        const head = await mid('[data-testid="pv-show-toolhead"]')
        const gantry = await mid('[data-testid="pv-show-gantry"]')
        const follow = await mid('label:has-text("Follow nozzle") input, input[aria-label="Follow nozzle"]')
        const read = await mid('.dock-read')
        const where = `${size.width} ${want}${folded ? ' folded' : ''}`
        expect(Math.abs(play - speed), where).toBeLessThan(4)
        expect(Math.abs(head - gantry), where).toBeLessThan(2)
        expect(Math.abs(head - follow), where).toBeLessThan(2)
        expect(Math.abs(head - read), where).toBeLessThan(4)
        if (folded) expect(Math.abs(head - play), where).toBeLessThan(4)
        else expect(head - play, where).toBeGreaterThan(16)
        // The tab and the plate chips never meet.
        const t = (await edgeTab.boundingBox())!
        for (const chip of await page.locator('.vp > .hud-bl > *').all()) {
          const c = await chip.boundingBox()
          if (!c) continue
          const apart = c.x + c.width + 8 <= t.x || t.x + t.width + 8 <= c.x || c.y + c.height + 8 <= t.y || t.y + t.height + 8 <= c.y
          expect(apart, `${where}: chip ${JSON.stringify(c)} tab ${JSON.stringify(t)}`).toBe(true)
        }
      }
      // The slider tracks run to the readout column: no more than the readout's own column and gaps after them.
      const time = (await dock.locator('#pv-time').boundingBox())!
      const out = (await dock.locator('output[for="pv-time"]').boundingBox())!
      expect(out.x - (time.x + time.width), `${size.width}`).toBeLessThan(24)
    }
  })

  test('printer and filament controls stay reachable at shorter window heights', async ({ page }) => {
    await sliceBox(page, { mode: 'simple' })
    await page.setViewportSize({ width: 1280, height: 800 })
    const pane = page.locator('aside.pane[data-side="left"]')
    const body = pane.locator('.sx-rail-body')
    const footer = pane.locator('.sx-rail-foot')
    for (const size of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1440, height: 700 }]) {
      await page.setViewportSize(size)
      await viewSized(page)
      const footerBefore = await footer.boundingBox()
      for (const control of [page.getByTestId('slice-machine-plate'), page.getByTestId('slice-filament-slot').last(), page.getByRole('radiogroup', { name: 'Supports' })]) {
        await control.scrollIntoViewIfNeeded()
        await expect(control).toBeInViewport()
        expect(await footer.boundingBox()).toEqual(footerBefore)
      }
      await body.evaluate((el) => el.scrollTo(0, 0))
      await expect(page.getByTestId('slice-machine-card')).toBeInViewport()
      await expect(footer).toBeInViewport()
    }
  })

  test('the plate toolbar drags anywhere in the view, stays inside it, and keeps to the arrow keys', async ({ page }) => {
    await calm(page, 'simple')
    const group = page.getByTestId('plate-tools-group')
    const grip = page.getByTestId('plate-tools-grip')
    const view = (await page.locator('.vp').boundingBox())!
    const drag = async (dx: number, dy: number) => {
      await grip.hover()
      const g = (await grip.boundingBox())!
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
      await page.mouse.down()
      await page.mouse.move(g.x + g.width / 2 + dx, g.y + g.height / 2 + dy, { steps: 6 })
      await page.mouse.up()
    }
    // Into the top left corner first, so there is room to move whatever an earlier test did with it (that it starts at
    // the top is checked on a new page, in the test of the bar's defaults).
    await drag(-3000, -3000)
    const start = (await group.boundingBox())!
    await drag(150, 200)
    const moved = (await group.boundingBox())!
    expect(moved.x - start.x).toBeCloseTo(150, 0)
    expect(moved.y - start.y).toBeCloseTo(200, 0)
    await expect(group).toHaveAttribute('data-moved', 'true')
    // Far past the view's corner: it stops inside, 8 px from the edges.
    await drag(3000, 3000)
    const end = (await group.boundingBox())!
    expect(end.x + end.width).toBeLessThanOrEqual(view.x + view.width - 7.5)
    expect(end.y + end.height).toBeLessThanOrEqual(view.y + view.height - 7.5)
    // The arrow keys move it too, from the grip.
    await grip.focus()
    await page.keyboard.press('ArrowLeft')
    expect((await group.boundingBox())!.x).toBeCloseTo(end.x - 16, 0)
  })

  test('the view shows no focus ring after a click and a key, and a quiet edge when Tab brings focus to it', async ({ page }) => {
    await calm(page, 'simple')
    const canvas = page.locator('.vp-canvas')
    await page.mouse.click(700, 450)
    await page.keyboard.press('ArrowDown')
    await expect(canvas).toBeFocused()
    expect(await canvas.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none')
    await canvas.evaluate((el) => (el as HTMLElement).blur())
    // Tab from the element just before the view lands on it.
    await canvas.evaluate((el) => {
      const before = document.createElement('button')
      before.id = 'e2e-before-view'
      el.parentElement!.insertBefore(before, el)
      before.focus()
    })
    try {
      await page.keyboard.press('Tab')
      await expect(canvas).toBeFocused()
      await expect(canvas).toHaveAttribute('data-tab-focus', '')
      expect(await canvas.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }))).toEqual({ style: 'solid', width: '1px' })
    } finally {
      await page.evaluate(() => document.getElementById('e2e-before-view')?.remove())
    }
  })
})

// What a new session shows, and what a reload keeps: this needs a cold start of its own, so it opens a page of its own
// (fresh storage, the session flags a person's first load has) beside the shared one.
test('the playback bar starts shut, the legend as its chip and Show toolhead on, the choices are kept, and the plate toolbar starts at the top again', async ({ browser }) => {
  test.slow()
  const use = test.info().project.use
  const context = await browser.newContext({ viewport: use.viewport ?? { width: 1440, height: 900 }, ...(use.baseURL ? { baseURL: use.baseURL } : {}) })
  await prepareContext(context)
  const page = await context.newPage()
  await preparePage(page)
  try {
    await page.addInitScript(() => {
      sessionStorage.setItem('sx-right-pane', 'open')
      sessionStorage.setItem('sx-preview-drawer', 'shut')
      localStorage.setItem('slicerx.debug', '1')
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, printerId: 'bay-1' }))
    })
    await page.goto('./')
    await plateReady(page)
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
    const slice = async () => {
      await boxOnPlate(page)
      await startSlice(page)
    }
    await slice()
    // The legend starts shut to its chip, in one row with the view switch in the top left corner, clear of the plate
    // toolbar; its list opens from the chip's list button.
    const legendRow = page.getByTestId('legend-row')
    const legendList = page.getByRole('list', { name: 'Toolpath legend' })
    const legendToggle = page.getByTestId('legend-toggle')
    await expect(legendRow.getByTestId('legend-color-by')).toBeVisible()
    await expect(legendRow.getByRole('radiogroup', { name: 'How the plate shows the slice' })).toBeVisible()
    await expect(legendToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(legendList).toHaveCount(0)
    const row = (await legendRow.boundingBox())!
    const bar = (await page.getByTestId('plate-tools-group').boundingBox())!
    expect(row.y).toBeGreaterThanOrEqual(bar.y + bar.height)
    await legendToggle.click()
    await expect(legendList).toBeVisible()
    await expect(legendToggle).toHaveAttribute('aria-expanded', 'true')
    const dock = page.getByTestId('preview-drawer')
    const edgeTab = dock.getByTestId('edge-tab-bottom')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    await expect(edgeTab).toHaveAttribute('aria-expanded', 'false')
    await expect(dock.getByRole('button', { name: 'Play print' })).toBeVisible()
    await expect(dock.getByLabel('Time', { exact: true })).toBeHidden()
    // The tab sits on the bar's top edge, near its right end, and is big enough to hit.
    const t = (await edgeTab.boundingBox())!
    const d = (await dock.boundingBox())!
    expect(Math.abs(t.y + t.height - d.y)).toBeLessThan(1.5)
    expect(Math.abs(d.x + d.width - (t.x + t.width) - 24)).toBeLessThan(1.5)
    expect(t.width).toBeGreaterThanOrEqual(72)
    expect(t.height).toBeGreaterThanOrEqual(22)
    await edgeTab.click()
    await expect(dock).toHaveAttribute('data-mode', 'full')
    await expect(edgeTab).toHaveAttribute('aria-expanded', 'true')
    await expect(dock.getByLabel('Time', { exact: true })).toBeVisible()
    await page.mouse.move(700, 300)
    await page.keyboard.press('ControlOrMeta+j')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    await page.keyboard.press('ControlOrMeta+j')
    await expect(dock).toHaveAttribute('data-mode', 'full')

    // Show toolhead starts on and Show gantry off, each its own switch.
    const head = page.getByTestId('pv-show-toolhead')
    const gantry = page.getByTestId('pv-show-gantry')
    await expect(head).toBeChecked()
    await expect(gantry).not.toBeChecked()
    const flags = () => page.evaluate(() => { const s = (window as unknown as { __sx: { getState(): Snap } }).__sx.getState(); return { showToolhead: s.showToolhead, showGantry: s.showGantry } })
    expect(await flags()).toEqual({ showToolhead: true, showGantry: false })
    await gantry.check()
    expect(await flags()).toEqual({ showToolhead: true, showGantry: true })
    await head.uncheck()
    expect(await flags()).toEqual({ showToolhead: false, showGantry: true })

    // The plate toolbar moves, and a new session starts it at the top.
    const group = page.getByTestId('plate-tools-group')
    const grip = page.getByTestId('plate-tools-grip')
    const start = (await group.boundingBox())!
    // Level with the corner buttons, near the top of the view.
    expect(start.y - (await page.locator('.vp').boundingBox())!.y).toBeLessThanOrEqual(14)
    await grip.hover()
    const g = (await grip.boundingBox())!
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    await page.mouse.down()
    await page.mouse.move(g.x + g.width / 2 - 150, g.y + g.height / 2 + 200, { steps: 6 })
    await page.mouse.up()
    await expect(group).toHaveAttribute('data-moved', 'true')

    // Reloaded: the person's choices are kept, the toolbar is not.
    await page.reload()
    await plateReady(page)
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
    await expect(page.getByTestId('plate-tools-group')).not.toHaveAttribute('data-moved', /.*/)
    expect((await page.getByTestId('plate-tools-group').boundingBox())!.y).toBeCloseTo(start.y, 0)
    await slice()
    await expect(page.getByTestId('preview-drawer')).toHaveAttribute('data-mode', 'full')
    await expect(page.getByTestId('pv-show-toolhead')).not.toBeChecked()
    await expect(page.getByTestId('pv-show-gantry')).toBeChecked()
    // The legend's list stays open, as it was left.
    await expect(page.getByTestId('legend-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('list', { name: 'Toolpath legend' })).toBeVisible()
  } finally {
    await context.close()
  }
})

// ---- The layer pins on the playback bar's Layer slider ----

test.describe('layer pins', () => {
  // Thin layers, so the bar has the 190 or so layers the pins are spread over, and a thick first layer so the layer
  // heights are not one step apart.
  const THIN = { layer_height: '0.1', initial_layer_print_height: '0.3', smart_layer: 'off' }
  const dockOf = (page: Page) => page.getByRole('group', { name: 'Layers and moves' })

  async function pinned(page: Page): Promise<Locator> {
    await sliceBox(page, { overrides: THIN })
    const dock = dockOf(page)
    // With both side panes open the bar is under 1000 px wide and folds to one control row; it does that in its own time
    // after the window or the panes changed, and a test that measures the bar starts when it has.
    await expect(dock).toHaveAttribute('data-narrow', 'true')
    return dock
  }

  const slotX = async (page: Page, layer: number) => Math.round(await thumbX(page, layer))

  /** Boxes of the bar's controls and of what sits above it, leaving out the pins and the layer slider's own thumb. */
  async function staticBoxes(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const out: Record<string, string> = {}
      const dock = document.querySelector('[data-testid="preview-drawer"]')!
      const els = [...dock.querySelectorAll('button, input, label, output, [role="radio"]'), ...document.querySelectorAll('.plate-tools-group, .vp .hud-bl > *, .vp .hud-top .hud-col > *, .sx-appbar .sx-btn')]
      const seen: Record<string, number> = {}
      for (const el of els) {
        if (el.closest('.layer-marks, [role="menu"], dialog') || el.classList.contains('dock-jump-field')) continue
        const r = el.getBoundingClientRect()
        if (!r.width) continue
        // named by what it is, not by what it reads, since the readouts change with the layer
        const name = `${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0]} ${(el.getAttribute('aria-label') ?? el.id ?? '').replace(/\d+/g, '#').slice(0, 24)}`
        seen[name] = (seen[name] ?? 0) + 1
        out[`${name} ${seen[name]}`] = [r.x, r.y, r.width, r.height].map((v) => v.toFixed(1)).join(' ')
      }
      return out
    })
  }
  const moved = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} -> ${b[k] ?? 'gone'}`)

  // Where pins stand, how crowded ones step into lanes and share a "+N" pin, which pin a pointer picks, and the mark
  // heights are layer-marks.test.ts:84-196 and :227-266; the typed layer or height parsing is layer-step.test.ts:63-82.

  test("a pin's tip covers no control of the bar at three widths, and opens over the bar's top edge", async ({ page }) => {
    test.slow()
    const dock = await pinned(page)
    const n = await layerCount(page)
    const far = n - 8
    await marks(page, [[5, 'pause'], [20, 'color_change'], [150, 'custom'], [far, 'pause']])
    for (const [width, height] of [[1920, 1080], [1440, 900], [960, 900]] as const) {
      await page.setViewportSize({ width, height })
      await expect(dock).toBeVisible()
      const bar = (await dock.boundingBox())!
      for (const [i, text] of ['Layer 5, Pause', 'Layer 20, Color change', 'Layer 150, Custom G-code', `Layer ${far}, Pause`].entries()) {
        const head = page.locator('.layer-mark:not(.strike-mark)').nth(i)
        await head.hover()
        const tip = page.getByRole('tooltip').filter({ hasText: text })
        await expect(tip).toBeVisible()
        expect(await tipCovers(page, tip), `${width} px: ${text}`).toEqual([])
        const t = (await tip.boundingBox())!
        // over the bar's top edge, inside the view, and over its own pin
        expect(t.y + t.height, text).toBeLessThanOrEqual(bar.y)
        expect(t.y, text).toBeGreaterThanOrEqual(0)
        const p = await center(head)
        expect(p.x, text).toBeGreaterThanOrEqual(t.x - 1)
        expect(p.x, text).toBeLessThanOrEqual(t.x + t.width + 1)
        for (const b of transport(dock)) expect(clear(t, (await b.boundingBox())!), `${text} and ${await b.getAttribute('aria-label')}`).toBe(true)
        await page.mouse.move(2, 2)
        await expect(tip).toBeHidden()
      }
    }
  })

  test('pins stand on stems over their layer, clear of the Time and Moves tracks, with tips above', async ({ page }) => {
    await pinned(page)
    const n = await layerCount(page)
    const far = n - 8
    await marks(page, [[5, 'pause'], [120, 'color_change'], [far, 'custom']])
    const time = (await page.locator('#pv-time').boundingBox())!
    const track = (await page.locator('#pv-layer').boundingBox())!
    const moves = (await page.locator('#pv-moves').boundingBox())!
    for (const [i, layer] of [5, 120, far].entries()) {
      const head = page.locator('.layer-mark:not(.strike-mark)').nth(i)
      const b = (await head.boundingBox())!
      // over the layer's slot, within a pixel of where the thumb stands at that layer
      expect(Math.abs(b.x + b.width / 2 - (await thumbX(page, layer)))).toBeLessThan(1.01)
      // the head is above the track, and its stem reaches down to the track's line
      expect(b.y + b.height).toBeLessThanOrEqual(track.y + 0.5)
      const foot = (await head.locator('.layer-mark-leg').boundingBox())!
      expect(foot.y + foot.height).toBeGreaterThanOrEqual(track.y + track.height / 2 - 2)
      // never over the Moves track, and clear of the Time track's thumb
      expect(b.y + b.height).toBeLessThan(moves.y)
      expect(b.y).toBeGreaterThanOrEqual(time.y + time.height)
    }
    const second = page.locator('.layer-mark:not(.strike-mark)').nth(1)
    await second.hover()
    const tip = page.getByRole('tooltip').filter({ hasText: 'Layer 120, Color change' })
    await expect(tip).toBeVisible()
    const pinTop = (await second.boundingBox())!.y
    await expect.poll(async () => { const t = (await tip.boundingBox())!; return t.y + t.height }).toBeLessThanOrEqual(pinTop + 0.5)
  })

  test('crowded pins step up into lanes, and each one is its own click', async ({ page }) => {
    await pinned(page)
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom'], [150, 'pause']])
    const pins = page.locator('.layer-mark:not(.strike-mark)')
    expect(await pins.evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')))).toEqual(['0', '1', '2', '0'])
    const boxes = await Promise.all([0, 1, 2].map(async (i) => (await pins.nth(i).boundingBox())!))
    for (let i = 0; i < 2; i++) expect(boxes[i + 1]!.y + boxes[i + 1]!.height).toBeLessThanOrEqual(boxes[i]!.y)
    const time = (await page.locator('#pv-time').boundingBox())!
    expect(boxes[2]!.y).toBeGreaterThanOrEqual(time.y + time.height)
    // each one is its own click
    await pins.nth(2).click()
    await expect.poll(() => layerHi(page)).toBe(22)
    await expect(page.getByRole('menuitem', { name: 'Remove custom G-code' })).toBeVisible()
  })

  test('a right-click on the track lands on the layer under the pointer, and a pin click jumps back to it', async ({ page }) => {
    await pinned(page)
    const x = await thumbX(page, 100)
    const track = (await page.locator('#pv-layer').boundingBox())!
    // a little off the slot still lands on it
    await page.mouse.click(x + 0.4, track.y + track.height / 2, { button: 'right' })
    await expect.poll(() => layerHi(page)).toBe(100)
    await page.getByRole('menuitem', { name: 'Add pause' }).click()
    const s = await state(page)
    expect(s.layerMarks[s.activePlate]![0]!.z).toBeCloseTo(s.preview!.layerZ[99]!, 4)
    const only = page.locator('.layer-mark:not(.strike-mark)')
    await expect(only).toHaveAttribute('aria-label', /^Pause at layer 100, \d+\.\d\d mm$/)
    // somewhere else, then the pin: it jumps back the way a typed layer does, and its menu offers to remove it
    await page.locator('#pv-layer').focus()
    await page.keyboard.press('End')
    await expect.poll(() => layerHi(page)).not.toBe(100)
    await only.click()
    await expect.poll(() => layerHi(page)).toBe(100)
    await expect(page.getByRole('menuitem', { name: 'Remove pause' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Remove pause' }).click()
    await expect(only).toHaveCount(0)
  })

  test('the layer number is typed in: Enter goes there, Esc puts it back', async ({ page }) => {
    await pinned(page)
    const before = await layerHi(page)
    await page.locator('.dock-jump-num').click()
    const field = page.getByTestId('pv-layer-jump')
    await field.fill('42')
    await field.press('Escape')
    await expect(field).toBeHidden()
    expect(await layerHi(page)).toBe(before)
    await expect(page.locator('.dock-jump-num')).toHaveText(String(before))
    await page.locator('.dock-jump-num').click()
    await field.fill('42')
    await field.press('Enter')
    await expect.poll(() => layerHi(page)).toBe(42)
    await expect(page.locator('.dock-jump-num')).toHaveText('42')
  })

  test('the bar is 174 px, with one control row while it is under 1000 px wide', async ({ page }) => {
    const dock = await pinned(page)
    // the right pane is open (the journeys' default), so the bar is under 1000 px: one control row
    await expect(dock).toHaveAttribute('data-narrow', 'true')
    await expect(dock.locator('.dock-h2')).toHaveCount(0)
    await expect(dock.getByRole('button', { name: /^Playback speed/ })).toBeVisible()
    expect((await dock.boundingBox())!.height).toBeCloseTo(174, 0)
    // a smaller window: the readout stays one line, so the folded bar keeps its height
    await page.setViewportSize({ width: 960, height: 900 })
    await expect.poll(async () => (await dock.boundingBox())!.width).toBeLessThan(600)
    await expect.poll(async () => (await dock.boundingBox())!.height).toBeCloseTo(174, 0)
    const play = (await dock.getByRole('button', { name: 'Play print' }).boundingBox())!
    const read = (await dock.locator('.dock-read').boundingBox())!
    expect(read.height).toBeLessThanOrEqual(play.height)
    expect(play.width).toBeCloseTo(34, 0)
  })

  test('a wide bar keeps both control rows and the same pin band', async ({ page }) => {
    const dock = await pinned(page)
    // a big screen: with both side panes open the bar is still over 1000 px
    await page.setViewportSize({ width: 1920, height: 1080 })
    await expect.poll(async () => (await dock.boundingBox())!.width).toBeGreaterThanOrEqual(1000)
    await expect(dock).not.toHaveAttribute('data-narrow', 'true')
    await expect(dock.locator('.dock-h2')).toBeVisible()
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom']])
    const time = (await page.locator('#pv-time').boundingBox())!
    const top = (await page.locator('.layer-mark[data-lane="2"]').boundingBox())!
    expect(top.y).toBeGreaterThanOrEqual(time.y + time.height)
  })

  test('opening the bar, a pin click and a layer change move nothing beside or above them', async ({ page }) => {
    await pinned(page)
    await marks(page, [[5, 'pause'], [120, 'color_change']])
    const before = await staticBoxes(page)
    await page.locator('.layer-mark:not(.strike-mark)').nth(1).click()
    await expect.poll(() => layerHi(page)).toBe(120)
    await page.keyboard.press('Escape')
    expect(moved(before, await staticBoxes(page))).toEqual([])
    await page.locator('#pv-layer').focus()
    for (const key of ['Home', 'ArrowRight', 'PageUp', 'End']) {
      await page.keyboard.press(key)
      expect(moved(before, await staticBoxes(page)), key).toEqual([])
    }
    await page.locator('.dock-jump-num').click()
    await page.getByTestId('pv-layer-jump').fill('7')
    expect(moved(before, await staticBoxes(page))).toEqual([])
    await page.getByTestId('pv-layer-jump').press('Enter')
    await expect.poll(() => layerHi(page)).toBe(7)
    expect(moved(before, await staticBoxes(page))).toEqual([])
  })

  test('a crowded pin click goes to its own mark: layer 20, not 22, playback stopped, its own menu', async ({ page }) => {
    const dock = await pinned(page)
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom'], [150, 'pause']])
    await expect(pin(page, 'Pause at layer 20')).toHaveCount(1)
    await expect(pin(page, 'Color change at layer 21')).toHaveCount(1)
    await expect(pin(page, 'Custom G-code at layer 22')).toHaveCount(1)
    // playing from somewhere else
    await page.locator('#pv-layer').fill('100')
    await dock.getByRole('button', { name: 'Play print' }).click()
    await expect(dock.getByRole('button', { name: 'Pause playback' })).toBeVisible()
    // where the hit areas of two crowded pins overlap, the one drawn on top is not always the nearer head: find such a
    // point next to the layer 20 head, and the click must still go to the nearer one
    const spot = await page.evaluate(() => {
      const heads = [...document.querySelectorAll<HTMLElement>('.layer-mark[data-ids]')].map((el) => { const r = el.getBoundingClientRect(); return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 } })
      const p20 = heads.find((p) => p.el.getAttribute('aria-label')!.startsWith('Pause at layer 20'))!
      for (let dy = -16; dy <= 16; dy++)
        for (let dx = -16; dx <= 16; dx++) {
          const x = Math.round(p20.x) + dx
          const y = Math.round(p20.y) + dy
          const top = document.elementFromPoint(x, y)?.closest<HTMLElement>('.layer-mark[data-ids]')
          if (!top) continue
          const nearest = heads.slice().sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0]!
          if (nearest.el !== top && (nearest === p20 || top === p20.el)) return { x, y, top: top.getAttribute('aria-label')!, near: nearest.el.getAttribute('aria-label')!, layer: Number(nearest.el.dataset['layer']) }
        }
      return null
    })
    expect(spot, 'a point where two hit areas meet').not.toBeNull()
    await page.mouse.click(spot!.x, spot!.y)
    await expect.poll(() => layerHi(page), `${spot!.near} over ${spot!.top}`).toBe(spot!.layer)
    await expect(page.getByRole('menu', { name: spot!.near.replace(/, [\d.]+ mm$/, '') })).toBeVisible()
    await page.keyboard.press('Escape')
    // playing again, then the layer 20 pin itself
    await dock.getByRole('button', { name: 'Play print' }).click()
    await expect(dock.getByRole('button', { name: 'Pause playback' })).toBeVisible()
    await pin(page, 'Pause at layer 20').click()
    await expect.poll(() => layerHi(page)).toBe(20)
    await expect(dock.getByRole('button', { name: 'Play print' })).toBeVisible()
    const menu = page.getByRole('menu', { name: 'Pause at layer 20' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Remove pause' })).toBeVisible()
    await expect(pin(page, 'Pause at layer 20')).toHaveAttribute('data-selected', 'true')
    // each of the others is its own click, to its own layer and menu
    for (const [name, layer, item] of [['Color change at layer 21', 21, 'Remove color change'], ['Custom G-code at layer 22', 22, 'Remove custom G-code']] as const) {
      // the open menu sits over the crowd; Escape shuts it first
      await page.keyboard.press('Escape')
      await pin(page, name).click()
      await expect.poll(() => layerHi(page)).toBe(layer)
      await expect(page.getByRole('menu', { name })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: item })).toBeVisible()
    }
    // the menu's remove takes that mark only
    await page.getByRole('menuitem', { name: 'Remove custom G-code' }).click()
    const s = await state(page)
    expect(s.layerMarks[s.activePlate]!.map((m) => m.id)).toEqual(['m0', 'm1', 'm3'])
  })

  test('two marks on one layer are two pins, each with its own menu', async ({ page }) => {
    await pinned(page)
    const z = (await state(page)).preview!.layerZ
    // the second sits between the tops of layers 19 and 20, so it shows on layer 20 too
    const below = Math.round(((z[19]! - z[18]!) / 2) * 1e4) / 1e4
    await marks(page, [[20, 'pause'], [20, 'color_change', below]])
    const pause = pin(page, 'Pause at layer 20')
    const change = pin(page, 'Color change at layer 20')
    await expect(pause).toHaveCount(1)
    await expect(change).toHaveCount(1)
    expect(new Set(await page.locator('.layer-mark:not(.strike-mark)').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')))).size).toBe(2)
    await change.click()
    await expect(page.getByRole('menuitem', { name: 'Remove color change' })).toBeVisible()
    await page.keyboard.press('Escape')
    await pause.click()
    await expect(page.getByRole('menuitem', { name: 'Remove pause' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Remove color change' })).toHaveCount(0)
    // a right-click on that layer's slot lists both
    const x = await slotX(page, 20)
    const track = (await page.locator('#pv-layer').boundingBox())!
    await page.keyboard.press('Escape')
    await page.mouse.click(x, Math.round(track.y + track.height / 2), { button: 'right' })
    const list = page.getByRole('menu', { name: 'Layer actions near layer 20' })
    await expect(list.getByRole('menuitem', { name: / at layer / })).toHaveText([/^Color change at layer 20, /, /^Pause at layer 20, /])
  })

  test('past three lanes the crowd shares a "+N" pin that lists every mark in order', async ({ page }) => {
    await pinned(page)
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom'], [23, 'pause'], [24, 'color_change'], [150, 'pause']], 4)
    const group = page.locator('.layer-mark[data-kind="group"]')
    await expect(group).toHaveCount(1)
    await expect(group).toHaveText('+3')
    await expect(group).toHaveAttribute('aria-label', '3 layer actions, layers 22 to 24')
    // inside the three-lane band, under nothing
    const time = (await page.locator('#pv-time').boundingBox())!
    expect((await group.boundingBox())!.y).toBeGreaterThanOrEqual(time.y + time.height)
    const lanes = () => page.locator('.layer-mark:not(.strike-mark)').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-ids')}:${e.getAttribute('data-lane')}`))
    expect(await lanes()).toEqual(['m0:0', 'm1:1', 'm2 m3 m4:2', 'm5:0'])
    await group.click()
    const list = page.getByRole('menu', { name: 'Layer actions near layer 22' })
    await expect(list.getByRole('menuitem', { name: / at layer / })).toHaveText([/^Custom G-code at layer 22, /, /^Pause at layer 23, /, /^Color change at layer 24, /])
    await list.getByRole('menuitem', { name: /^Pause at layer 23/ }).click()
    await expect.poll(() => layerHi(page)).toBe(23)
    await expect(page.getByRole('menu', { name: 'Pause at layer 23' }).getByRole('menuitem', { name: 'Remove pause' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('the keyboard reaches each pin with its tip, and Escape shuts a menu back to what opened it', async ({ page }) => {
    await pinned(page)
    await marks(page, [[20, 'pause'], [21, 'color_change']])
    const first = pin(page, 'Pause at layer 20')
    // The tip shows for a focus the key moved within a moment of the key; a person whose Tab showed none presses it again.
    await expect(async () => {
      await page.locator('#pv-layer').focus()
      await page.keyboard.press('Tab')
      await expect(first).toBeFocused({ timeout: 2_000 })
      await expect(page.getByRole('tooltip').filter({ hasText: 'Layer 20, Pause' })).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 20_000 })
    await expect(async () => {
      await first.focus()
      await page.keyboard.press('Tab')
      await expect(pin(page, 'Color change at layer 21')).toBeFocused({ timeout: 2_000 })
      await expect(page.getByRole('tooltip').filter({ hasText: 'Layer 21, Color change' })).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 20_000 })
    await page.keyboard.press('Enter')
    await expect.poll(() => layerHi(page)).toBe(21)
    const menu = page.getByRole('menu', { name: 'Color change at layer 21' })
    await expect(menu).toBeVisible()
    await expect(page.locator(':focus')).toHaveAttribute('role', /menuitem/)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(pin(page, 'Color change at layer 21')).toBeFocused()
    // a right-click menu gives the focus back to the slider
    const track = (await page.locator('#pv-layer').boundingBox())!
    await page.mouse.click(await slotX(page, 100), Math.round(track.y + track.height / 2), { button: 'right' })
    await expect(page.getByRole('menu', { name: 'Layer 100 actions' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#pv-layer')).toBeFocused()
  })

  test('a typed layer number that is refused stays open and marked, and keys typed there drive nothing else', async ({ page }) => {
    const dock = await pinned(page)
    await page.locator('#pv-layer').fill('30')
    const field = page.getByTestId('pv-layer-jump')
    const open = async () => {
      await page.locator('.dock-jump-num').click()
      await expect(field).toBeFocused()
    }
    // refused, the field stays open and marked, and the layer stays (the words it takes are layer-step.test.ts:63-82)
    await open()
    await field.fill('abc')
    await field.press('Enter')
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(await layerHi(page)).toBe(30)
    await field.press('Escape')
    await expect(field).toBeHidden()
    await open()
    await field.fill(' 42 ')
    await field.press('Enter')
    await expect(field).toBeHidden()
    await expect.poll(() => layerHi(page)).toBe(42)
    // leaving the field drops what was typed, as Escape does
    await open()
    await field.fill('17')
    await page.locator('#pv-time').focus()
    await expect(field).toBeHidden()
    expect(await layerHi(page)).toBe(42)
    // typing: Space, arrows, Home and letters stay in the field
    await open()
    for (const key of ['Space', 'ArrowUp', 'ArrowRight', 'PageUp', 'Home', 'End', 'g', 'p', 'l']) await field.press(key)
    await expect(field).toBeVisible()
    expect(await layerHi(page)).toBe(42)
    await expect(dock.getByRole('button', { name: 'Play print' })).toBeVisible()
    await field.press('Escape')
  })

  // The bar folds at 1000 px of its own width and the window at 900 px; the check samples the fold state frame by frame.
  test('the bar folds by its own width: either side of 1000 px and of the 900 px window, with no flicker', { tag: '@nightly' }, async ({ page }) => {
    const dock = await pinned(page)
    await page.setViewportSize({ width: 1920, height: 1080 })
    const sides = async () => {
      const box = (await dock.boundingBox())!
      return 1920 - box.width
    }
    await expect.poll(async () => (await dock.boundingBox())!.width).toBeGreaterThan(1000)
    const side = await sides()
    /** The fold state over 20 frames after the window settles: it must not change. */
    const frames = () =>
      page.evaluate(
        () =>
          new Promise<string[]>((done) => {
            const out: string[] = []
            const step = () => {
              const el = document.querySelector('[data-testid="preview-drawer"]')
              out.push(`${el?.getAttribute('data-narrow') ?? '-'} ${el?.getAttribute('data-phone') ?? '-'}`)
              if (out.length < 20) requestAnimationFrame(step)
              else done(out)
            }
            requestAnimationFrame(step)
          }),
      )
    for (const [bar, narrow] of [[990, true], [999, true], [1001, false], [1010, false]] as const) {
      await page.setViewportSize({ width: Math.round(side + bar), height: 1080 })
      await expect.poll(async () => Math.round((await dock.boundingBox())!.width), `bar ${bar}`).toBe(bar)
      if (narrow) await expect(dock).toHaveAttribute('data-narrow', 'true')
      else await expect(dock).not.toHaveAttribute('data-narrow', 'true')
      const seen = await frames()
      expect(new Set(seen).size, `bar ${bar}: ${seen.join(', ')}`).toBe(1)
      expect((await dock.boundingBox())!.height).toBeCloseTo(narrow ? 174 : 204, 0)
    }
    // the window either side of the 900 px layout change: the full bar at 901, the phone row at 899
    for (const [w, phone] of [[901, false], [899, true]] as const) {
      await page.setViewportSize({ width: w, height: 900 })
      await expect(dock).toBeVisible()
      if (phone) {
        await expect(dock).toHaveAttribute('data-phone', 'true')
        await expect(dock).not.toHaveAttribute('data-narrow', 'true')
      } else {
        await expect(dock).not.toHaveAttribute('data-phone', 'true')
        await expect(dock).toHaveAttribute('data-narrow', 'true')
      }
      const seen = await frames()
      expect(new Set(seen).size, `window ${w}: ${seen.join(', ')}`).toBe(1)
    }
  })

  // four loaded slots of our own, so the menu can only show them by reading them
  const SLOTS = { 1: { type: 'PLA', brand: '', color: '#E5484D' }, 2: { type: 'PETG', brand: '', color: '#30A46C' }, 3: { type: 'ABS', brand: '', color: '#3E63DD' }, 4: { type: 'TPU', brand: '', color: '#F5D90A' } }

  /** Adds a color change at `layer` from a right-click, noting `slot`; returns its pin. */
  async function colorChange(page: Page, layer: number, slot: number): Promise<Locator> {
    const track = (await page.locator('#pv-layer').boundingBox())!
    await page.mouse.click(await slotX(page, layer), Math.round(track.y + track.height / 2), { button: 'right' })
    await page.getByRole('menuitem', { name: 'Add color change' }).click()
    await page.getByRole('menu', { name: `Color change at layer ${layer}` }).getByRole('menuitemcheckbox', { name: new RegExp(`Slot ${slot}`) }).click()
    return pin(page, `Color change at layer ${layer}`)
  }

  test('a color change notes a loaded slot, and the note leaves the slice and its G-code as they are', async ({ page }) => {
    test.slow()
    await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
    await pinned(page)
    await patch(page, { slotSetup: SLOTS })
    try {
      const track = (await page.locator('#pv-layer').boundingBox())!
      await page.mouse.click(await slotX(page, 40), Math.round(track.y + track.height / 2), { button: 'right' })
      await page.getByRole('menuitem', { name: 'Add color change' }).click()
      const picker = page.getByRole('menu', { name: 'Color change at layer 40' })
      await expect(picker.getByRole('menuitemcheckbox')).toHaveText([/Slot 1\s*PLA/, /Slot 2\s*next/, /Slot 3\s*ABS/, /Slot 4\s*TPU/])
      const swatches = await picker.getByRole('menuitemcheckbox').evaluateAll((els) => els.map((e) => getComputedStyle(e.querySelector('.swatch')!).backgroundColor))
      expect(swatches).toEqual(['rgb(229, 72, 77)', 'rgb(48, 164, 108)', 'rgb(62, 99, 221)', 'rgb(245, 217, 10)'])
      await expect(picker).toContainText('The slot is a note saved with the project')
      await picker.getByRole('menuitemcheckbox', { name: /Slot 3/ }).click()
      const change = pin(page, 'Color change at layer 40')
      await expect(change).toHaveCSS('background-color', 'rgb(62, 99, 221)')
      // a new mark changes the print: slice again before anything leaves
      await expect(sliced(page)).toHaveCount(0)
      await startSlice(page)
      const fs = await import('node:fs')
      const exportGcode = async () => {
        await page.keyboard.press('ControlOrMeta+k')
        await page.keyboard.type('Export G-code')
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.locator('.sx-palette-item', { hasText: /^Export G-code/ }).first().click()])
        return fs.readFileSync(await download.path(), 'utf8')
      }
      const before = await exportGcode()
      expect(before).toMatch(/\nM600/)
      const slice = (await state(page)).slice.result!.id
      // the note changes to slot 2: the slice stays current, nothing slices again, and the same G-code goes out
      await expect(async () => {
        await page.keyboard.press('Escape')
        await clearToasts(page)
        await change.click({ timeout: 5_000 })
        await page.getByRole('menu', { name: 'Color change at layer 40' }).getByRole('menuitemcheckbox', { name: /Slot 2/ }).click({ timeout: 5_000 })
      }).toPass({ timeout: 30_000 })
      await expect(change).toHaveCSS('background-color', 'rgb(48, 164, 108)')
      await expect(sliced(page)).toBeVisible()
      expect((await state(page)).slice).toMatchObject({ status: 'done', stale: false, result: { id: slice } })
      expect(await exportGcode()).toBe(before)
      // removing the mark changes the print: the old slice is stale and no G-code leaves until it slices again
      await change.click()
      await page.getByRole('menuitem', { name: 'Remove color change' }).click()
      await expect(change).toHaveCount(0)
      await expect.poll(async () => (await state(page)).slice.stale).toBe(true)
      await page.keyboard.press('ControlOrMeta+k')
      await page.keyboard.type('Export G-code')
      await page.locator('.sx-palette-item', { hasText: /^Export G-code/ }).first().click()
      await expect(page.getByText('The plate changed after this slice. Slice it again first.').first()).toBeVisible()
    } finally {
      await patch(page, { slotSetup: {} })
    }
  })

  test('the slot note survives a saved project opened again, and a slot not loaded there says so', async ({ page }) => {
    test.slow()
    await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
    await sliceBox(page)
    await patch(page, { slotSetup: SLOTS })
    try {
      await colorChange(page, 40, 3)
      await colorChange(page, 80, 4)
      // saved from the Export menu, as a person saves
      await addMenu(page, 'Export')
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
      expect(download.suggestedFilename()).toMatch(/\.sx3mf$/)
      const fs = await import('node:fs')
      const saved = fs.readFileSync(await download.path())
      // The page forgets the project, as a fresh browser has it: no plate, no pins, no slots loaded.
      await patch(page, { plate: [], selection: null, selectedIds: [], layerMarks: {}, slotSetup: {}, slice: { status: 'idle' } })
      const marksNow = () => page.evaluate(() => { const s = (window as unknown as { __sx: { getState(): Snap } }).__sx.getState(); return (s.layerMarks[s.activePlate] ?? []).map((m) => `${m.kind}:${m.slot ?? ''}`) })
      expect(await marksNow()).toEqual([])
      const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
      await chooser.setFiles({ name: 'Slot note.sx3mf', mimeType: 'model/3mf', buffer: saved })
      await expect.poll(marksNow, { timeout: 60_000 }).toEqual(['color_change:3', 'color_change:4'])
      // a printer with fewer slots: slot 4 is kept, and its menu says it is not loaded
      await patch(page, { slotSetup: { 1: { type: 'PLA', brand: '', color: '#E5484D' }, 2: { type: 'PETG', brand: '', color: '#30A46C' } }, printerSlots: [] })
      await startSlice(page)
      const four = pin(page, 'Color change at layer 80')
      await expect(four).toHaveAttribute('data-tip-body', /Slot 4, not loaded now/)
      await four.click()
      const menu = page.getByRole('menu', { name: 'Color change at layer 80' })
      await expect(menu.getByRole('menuitemcheckbox', { name: /Slot 4/ })).toHaveAttribute('aria-checked', 'true')
      await expect(menu.getByRole('menuitemcheckbox', { name: /Slot 4/ })).toBeDisabled()
      await expect(menu.getByRole('menuitemcheckbox', { name: /Slot 4/ })).toContainText('not loaded')
      expect(await marksNow()).toEqual(['color_change:3', 'color_change:4'])
    } finally {
      await patch(page, { slotSetup: {} })
    }
  })

  test('layers of different heights: a right-click lands on a sliced layer at both ends, and a new layer count clamps', async ({ page }) => {
    test.slow()
    // a thick first layer under thinner ones, which the layer plan may vary further: the heights are not one step apart
    const dock = await pinned(page)
    const s = await state(page)
    const z = Array.from(s.preview!.layerZ)
    const n = z.length
    expect(z[0]).toBeCloseTo(0.3, 3)
    expect(new Set(z.map((t, i) => (t - (z[i - 1] ?? 0)).toFixed(3))).size, 'layer heights').toBeGreaterThan(1)
    const track = (await page.locator('#pv-layer').boundingBox())!
    const y = Math.round(track.y + track.height / 2)
    for (const [x, layer] of [[Math.ceil(track.x), 1], [Math.round(track.x + 6.5), 1], [await slotX(page, 2), 2], [await slotX(page, n - 1), n - 1], [Math.floor(track.x + track.width) - 1, n]] as const) {
      await page.mouse.click(x, y, { button: 'right' })
      await expect.poll(() => layerHi(page), `at ${x}`).toBe(layer)
      await expect(page.getByRole('menu', { name: `Layer ${layer} actions` })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: `Layer ${layer}, ${z[layer - 1]!.toFixed(2)} mm` })).toBeVisible()
      await page.keyboard.press('Escape')
    }
    await page.mouse.click(Math.floor(track.x + track.width) - 1, y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Add pause' }).click()
    const mark = (await state(page)).layerMarks[s.activePlate]![0]!
    expect(mark.z).toBeCloseTo(z[n - 1]!, 4)
    // a slice with thicker layers has fewer of them: the top layer and the typed number clamp to the new count
    await patch(page, { overrides: { initial_layer_print_height: '0.3', layer_height: '0.28', smart_layer: 'off' } })
    await startSlice(page)
    const m = await layerCount(page)
    expect(m).toBeLessThan(n)
    await expect(dock.locator('.dock-jump-num')).toHaveText(String(m))
    expect(await layerHi(page)).toBe(m)
    await page.locator('.dock-jump-num').click()
    await page.getByTestId('pv-layer-jump').fill(String(n))
    await page.getByTestId('pv-layer-jump').press('Enter')
    await expect.poll(() => layerHi(page)).toBe(m)
    // the mark keeps its height and shows on the layer that reaches it
    await expect(page.locator('.layer-mark:not(.strike-mark)')).toHaveAttribute('aria-label', new RegExp(`^Pause at layer ${m},`))
  })
})


// ---- The Print sheet and the G-code a slice writes (moved from plate.spec.ts) ----

/**
 * The G-code the printer runs. Files for Bambu Lab printers open with the header and the full settings (hundreds
 * of lines, the start G-code among them as one escaped line) and the moves follow EXECUTABLE_BLOCK_START, as Orca
 * and Bambu Studio write them; other files start with the moves.
 */
function executable(text: string): string {
  const at = text.indexOf('; EXECUTABLE_BLOCK_START')
  return at < 0 ? text : text.slice(at)
}

function withoutThumbnails(text: string): string {
  return text.replace(/; THUMBNAIL_BLOCK_START[\s\S]*?; THUMBNAIL_BLOCK_END[^\n]*\n/g, '')
}

/** The Layered X plate with its meshes loaded (`layeredX` loads a new one when the plate on show is not the stashed one), after `calm`. */
async function liveLayered(page: Page): Promise<void> {
  await calm(page)
  await layeredX(page)
}

/** The G-code of the slice on the screen, from the Export G-code button. Headless Chromium has no save dialog, so the host downloads. */
async function exportedGcode(page: Page): Promise<string> {
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
  return readFileSync(await download.path(), 'utf8')
}

/** The same through the command bar. */
async function exportedFromPalette(page: Page): Promise<string> {
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  await page.keyboard.press('ControlOrMeta+k')
  // The command bar loads on its first use: keys typed before it is open go to the page instead.
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
  await page.keyboard.type('Export G-code')
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.sx-palette-item', { hasText: /^Export G-code/ }).first().click()])
  return readFileSync(await download.path(), 'utf8')
}

/** Whether a slice that finished after the first `after` slices of the page is the plate's current slice, made with the Layered X paint on it. */
function paintedSlice(page: Page, after: number): Promise<boolean> {
  return page.evaluate((after) => {
    const s = (window as unknown as { __sx: { getState(): { slicesDone: number; slice: { status: string; stale?: boolean }; plate: { name: string; paint?: object }[] } } }).__sx.getState()
    return s.slicesDone > after && s.slice.status === 'done' && !s.slice.stale && s.plate.some((p) => p.name === 'Layered X' && !!p.paint)
  }, after)
}

/** The Print sheet of the sliced Layered X plate, open and with its file check done. The slice is the one this page already holds when it is current. */
async function printSheet(page: Page): Promise<Locator> {
  await sliceLayered(page)
  await command(page, 'Print the plate on')
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible()
  return sheet
}

test.describe('the Print sheet', () => {
  test('sending runs the preflight and needs the bed-clear check', async ({ page }) => {
    test.slow()
    const sheet = await printSheet(page)
    // One sheet: what will print, the check against the printer, the printer's steps as toggles, and the confirm button as the approval.
    await expect(sheet).toContainText('Bed leveling')
    await expect(sheet.getByRole('switch', { name: 'Bed leveling' })).toHaveAttribute('aria-checked', 'true')
    await expect(sheet.getByRole('button', { name: /^Bed is clear, start/ })).toBeEnabled()
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await expect(sheet).toHaveCount(0)
  })

  test('send can upload without starting: no bed-clear question, and the file name is fixed', async ({ page }) => {
    test.slow()
    const sheet = await printSheet(page)
    // The name was decided with the plate: shown, not asked for.
    await expect(sheet.locator('.ps-file')).toContainText(/\.gcode/)
    await expect(sheet.getByLabel('File name on the printer')).toHaveCount(0)
    await sheet.getByRole('button', { name: 'More ways to send' }).click()
    await sheet.getByRole('menuitemcheckbox', { name: 'Upload only' }).click()
    await expect(sheet.getByRole('button', { name: 'Upload only' })).toBeEnabled()
    await expect(sheet).toContainText('Nothing starts')
    await expect(sheet.getByRole('button', { name: /Bed is clear/ })).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Cancel' }).click()
  })
})

test.describe('the object list and the estimate in words', () => {
  test('the object row and the estimate use plain words: parts, slot names, and the engine detail in tooltips', async ({ page }) => {
    test.slow()
    await sliceLayered(page)
    try {
      const row = page.locator('li.obj').first()
      const meta = row.locator('.obj-meta')
      await expect(meta).toHaveText('2 parts')
      await expect(meta).toHaveAttribute('data-tip-title', /^\d[\d,]* triangles$/)
      // A part's filament reads as its slot, type and color, as the printer's slots do.
      await row.getByTestId('slice-object-expand').click()
      await row.getByTestId('object-part-slot').first().click()
      const options = await page.getByRole('menu', { name: 'Filament' }).getByRole('menuitemcheckbox').allTextContents()
      await page.keyboard.press('Escape')
      expect(options[0]).toMatch(/^\S+ [A-Z][\w-]* [A-Z][a-z]+( [a-z]+)?$/)
      expect(options.join('|')).not.toMatch(/Filament \d/)
      // Developer mode shows the triangles inline.
      await patch(page, { settingsMode: 'developer' })
      await expect(meta).toHaveText(/^2 parts, \d[\d,]* triangles$/)
      await patch(page, { settingsMode: 'advanced' })
      // After a slice: the time's tooltip says how long it took; no threads note, no Warnings row at zero.
      const estimate = page.locator('[data-section="estimate"]')
      await expect(estimate.locator('.est-time')).toHaveAttribute('data-tip-title', /^Sliced in \d+(\.\d)? (ms|s)( on \d+ threads)?$/)
      await expect(estimate).not.toContainText('threads')
      await expect(estimate.locator('dt', { hasText: 'Warnings' })).toHaveCount(0)
      // The Sliced plate card: plain words, the engine detail in the line's tooltip, and inline only in Developer mode.
      const result = page.locator('[data-section="result"] .result-line').first()
      await expect(result).toHaveText(/^Sliced \d+ layers in \d+\.\d\d s\.$/)
      // The warnings have their own line under it.
      await expect(page.locator('[data-section="result"] .result-sub').first()).toHaveText(/^(No warnings|\d+ warnings?)\.$/)
      await expect(result).toHaveAttribute('data-tip-title', /^[\d,]+ toolpath segments from the (sx|Orca) engine$/)
      await expect(page.locator('[data-section="result"]')).not.toContainText('toolpath segments')
      await patch(page, { settingsMode: 'developer' })
      await expect(page.locator('[data-section="result"]')).toContainText('toolpath segments from the')
    } finally {
      await patch(page, { settingsMode: 'advanced' })
    }
  })
})

/**
 * What a calibration test changes: it adds a plate of its own and shows it, and saving a result writes a preset. The
 * page puts the plates back instead of starting a new project, which would free the Layered X meshes that `layeredX`
 * puts back on the plate.
 */
const CALIBRATION_KEEPS = ['plates', 'plate', 'activePlate', 'selection', 'selectedIds', 'calibration', 'userPresets']

test.describe('the G-code a slice writes', () => {
  test('seam paint changes where the seam lands in the sliced G-code', { tag: '@gpu' }, async ({ page }) => {
    test.slow()
    await sliceLayered(page)
    await keep(page, 'plate')
    try {
      const plainText = await exportedFromPalette(page)
      expect(plainText).toContain('G1')
      await tab(page, 'prepare').click()
      // The tool takes the objects card's place, so the model is selected first.
      await page.locator('.obj-name', { hasText: 'Layered X' }).click()
      await page.getByRole('button', { name: 'Paint', exact: true }).click()
      const panel = page.locator('[data-section="paint"]')
      await panel.getByRole('radio', { name: 'Seam' }).click()
      await panel.getByRole('radiogroup', { name: 'Brush' }).getByRole('radio', { name: 'Fill', exact: true }).click()
      // The view opens on the whole plate: bring the model to the middle of the view before painting it, once the right
      // pane the tool opens has finished sliding. With motion reduced the zoom is a jump, and the clicks wait until the
      // camera is still. The middle is where a zoom goes and stays put, so the wait watches a point above it.
      await panesSettled(page)
      await reducedMotion(page, async () => {
        await page.keyboard.press('z')
        const [mx, my, mz] = await layeredMid(page)
        await steady(page, mx, my, mz + 4)
        const { x: cx, y: cy } = await pressable(page, await screenOf(page, mx, my, mz))
        // Bucket fill on a spread of points over the model paints whole surfaces with the seam enforcer. A click between
        // the X's arms misses it and keeps the object selected for the next one.
        for (const [dx, dy] of [[-50, 0], [50, 0], [0, -40], [0, 40], [-30, 25], [30, -25], [-70, 30], [70, -30], [0, 0]] as const) await page.mouse.click(cx + dx, cy + dy)
      })
      await expect(panel.getByRole('button', { name: /Clear seam/ })).toBeEnabled()
      // The slice of the painted plate, and its G-code once that slice is the plate's current one. The toolpaths it
      // shows are drawn in software, which on a busy machine takes far longer than the slice: the export waits for the
      // slice, not for the drawing.
      const n = await page.evaluate(() => (window as unknown as { __sx: { getState(): { slicesDone: number } } }).__sx.getState().slicesDone)
      await command(page, 'Slice the plate')
      await expect.poll(() => paintedSlice(page, n), { timeout: 120_000 }).toBe(true)
      const painted = await exportedFromPalette(page)
      expect(painted).toContain('G1')
      // The same slice twice is the same G-code, so the difference is the paint.
      expect(painted).not.toBe(plainText)
    } finally {
      // The plate goes back without its paint, so the next test finds the plate it stashed. Putting it back takes no tab
      // change or Undo button, whose clicks wait for the drawing too.
      await patch(page, { objectTool: null })
      await restore(page)
    }
  })

  test('a pressure advance line test exports its own G-code, and an input shaping tower carries its commands', async ({ page }) => {
    test.slow()
    await calm(page)
    await keep(page, ...CALIBRATION_KEEPS)
    const open = async () => {
      await page.keyboard.press('ControlOrMeta+k')
      await page.keyboard.type('Calibration')
      await page.locator('.sx-palette-item', { hasText: 'Calibration: temperature' }).first().click()
      const d = page.getByRole('dialog', { name: 'Calibration' })
      // The list shows the tests this spool needs; the line and input shaping tests are under Show every test.
      const all = d.getByRole('checkbox', { name: 'Show every test' })
      if (!(await all.isChecked())) await all.check()
      return d
    }
    try {
      let dialog = await open()
      await dialog.getByRole('radio', { name: /Pressure advance lines/ }).click()
      await dialog.getByRole('button', { name: 'Add to a new plate' }).click()
      await expect(dialog.getByRole('region', { name: 'Result' })).toBeVisible({ timeout: 60_000 })
      await page.keyboard.press('Escape')
      await startSlice(page)
      const pa = await exportedFromPalette(page)
      expect(pa).toContain('calibration test: G-code from the test')
      expect(pa).toMatch(/M900 K|SET_PRESSURE_ADVANCE|M572|M233/)
      // The test's own G-code is the body: many lines, each at its own value.
      expect((pa.match(/M900 K|SET_PRESSURE_ADVANCE|M572 D0|M233/g) ?? []).length).toBeGreaterThan(5)
      await tab(page, 'prepare').click()
      dialog = await open()
      await dialog.getByRole('radio', { name: /Input shaping frequency/ }).click()
      await dialog.getByRole('button', { name: 'Add to a new plate' }).click()
      await expect(dialog.getByRole('region', { name: 'Result' })).toBeVisible({ timeout: 60_000 })
      await dialog.getByLabel('Best frequency').selectOption({ index: 3 })
      await expect(dialog.getByLabel('Commands for your printer')).toHaveValue(/M593|SET_INPUT_SHAPER|M593/)
      await page.keyboard.press('Escape')
      await startSlice(page)
      const tower = await exportedFromPalette(page)
      // One command per band, all present even though the plate is sliced in shards.
      expect((tower.match(/M593 |SET_INPUT_SHAPER /g) ?? []).length).toBeGreaterThanOrEqual(5)
    } finally {
      await calm(page)
      await restore(page)
    }
  })

  test('the shrinkage test builds its model and turns a measured length into a saved percentage', async ({ page }) => {
    test.slow()
    await calm(page)
    await keep(page, ...CALIBRATION_KEEPS)
    try {
      await page.keyboard.press('ControlOrMeta+k')
      await page.keyboard.type('Calibration')
      await page.locator('.sx-palette-item', { hasText: 'Calibration: temperature' }).first().click()
      const dialog = page.getByRole('dialog', { name: 'Calibration' })
      await dialog.getByRole('radio', { name: /Shrinkage/ }).click()
      await dialog.getByRole('button', { name: 'Add to a new plate' }).click()
      await expect(dialog.getByRole('region', { name: 'Result' })).toBeVisible({ timeout: 60_000 })
      await dialog.getByLabel('Measured arm length').fill('99.2')
      await expect(dialog.getByText(/Shrinkage: 99.2 %/)).toBeVisible()
      await dialog.getByLabel('Measured arm length').fill('40')
      await expect(dialog.getByText(/outside 50 to 150/)).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Save to filament' })).toBeDisabled()
      await dialog.getByLabel('Measured arm length').fill('99.2')
      await dialog.getByRole('button', { name: 'Save to filament' }).click()
      await expect(page.getByText(/saved for .* nozzle in "/)).toBeVisible()
    } finally {
      await calm(page)
      await restore(page)
    }
  })

  test('a part picked in the tree takes a setting of its own, the plate keeps its value, and the slice uses it', async ({ page }) => {
    test.slow()
    await sliceLayered(page)
    const gramsOf = (text: string): number => Number(/; total filament used \[g\] = ([\d.]+)/.exec(text)?.[1])
    try {
      const before = gramsOf(await exportedGcode(page))
      await tab(page, 'prepare').click()
      // A part picked in the object's tree: the scope is that part, and its infill is its own.
      const row = page.getByTestId('object-row').first()
      await row.getByTestId('slice-object-expand').click()
      await row.getByTestId('slice-object-part').first().click()
      await expect(page.getByTestId('slice-scope-label')).toContainText(await row.getByTestId('slice-object-part').first().innerText())
      await page.keyboard.press('ControlOrMeta+k')
      await page.locator('.sx-palette-input').fill('sparse infill density')
      await page.locator('.sx-palette-item', { hasText: 'now' }).first().click()
      const density = page.locator('[data-testid="slice-setting-row"][data-key="sparse_infill_density"]')
      await expect(density).toHaveAttribute('data-source', 'plate')
      await density.getByRole('textbox').fill('100')
      await density.getByRole('textbox').press('Enter')
      await expect(density).toHaveAttribute('data-source', 'own')
      // The plate keeps its own: on the Plate scope the row is the plate's value again.
      await page.getByTestId('slice-scope-plate').click()
      await expect(density.getByRole('textbox')).not.toHaveValue('100')
      await sliceDone(page)
      const after = gramsOf(await exportedGcode(page))
      expect(after).toBeGreaterThan(before)
    } finally {
      await patch(page, { objectSettings: {}, settingsScope: 'plate', expertOpen: false, selection: null, selectedIds: [] })
    }
  })

  test('sleipnir is on by default in the layer height picker and changes the layer count of a sphere', async ({ page }) => {
    test.slow()
    await calm(page)
    await plain(page)
    const picker = page.locator('#easy-layer')
    try {
      await expect(picker).toHaveText('sleipnir')
      const pick = async (name: string | RegExp): Promise<void> => {
        await picker.click()
        await page.getByRole('menuitemcheckbox', { name }).click()
      }
      // A sphere alone: the demo model comes off the plate.
      await patch(page, { plate: [], selection: null, selectedIds: [], slice: { status: 'idle' } })
      await addMenu(page, 'Add shape')
      await page.getByRole('menuitem', { name: 'Sphere' }).first().click()
      await expect(page.locator('.obj-name')).toHaveCount(1)
      const layers = async (): Promise<number> => {
        await sliceDone(page)
        // The toolpaths of this slice are up before the layers are counted: the Sliced plate card can still show the one before.
        await expect(sliced(page)).toBeVisible()
        const n = await layerCount(page)
        await tab(page, 'prepare').click()
        return n
      }
      const smart = await layers()
      await pick('0.20 mm')
      await expect(picker).toHaveText('0.20 mm')
      const fixed = await layers()
      expect(smart).not.toBe(fixed)
      await pick(/^sleipnir/)
      await expect(picker).toHaveText('sleipnir')
      expect(await layers()).toBe(smart)
    } finally {
      await plain(page)
    }
  })

  test('pause, color change and custom G-code are set on the layer slider and land in the G-code', async ({ page }) => {
    test.slow()
    await sliceLayered(page)
    try {
      const slider = page.locator('#pv-layer')
      await slider.fill('20')
      await page.getByRole('button', { name: 'Add layer action' }).click()
      await page.getByRole('menuitem', { name: 'Add pause' }).click()
      await slider.fill('40')
      await page.getByRole('button', { name: 'Add layer action' }).click()
      await page.getByRole('menuitem', { name: 'Add color change' }).click()
      // with two filaments loaded, a color change asks which one it changes to
      await page.getByRole('menuitemcheckbox', { name: /Slot 2/ }).click()
      await slider.fill('60')
      await page.getByRole('button', { name: 'Add layer action' }).click()
      await page.getByRole('menuitem', { name: 'Add custom G-code' }).click()
      const dialog = page.getByRole('dialog', { name: /Custom G-code at layer 60/ })
      await dialog.getByLabel('G-code').fill('M500')
      await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
      await expect(dialog).toContainText('printer memory')
      await dialog.getByLabel('G-code').fill('M117 Swap the lid')
      await dialog.getByRole('button', { name: 'Add' }).click()
      await expect(page.locator('.layer-mark')).toHaveCount(3)
      // The marks go into the next slice, at their layers.
      await tab(page, 'prepare').click()
      await sliceDone(page)
      const text = await exportedGcode(page)
      expect(text).toContain('M117 Swap the lid')
      // The pause is the printer profile's own pause G-code: M601 by default, M400 U1 on a Bambu Lab printer.
      const pause = /\n(M601|M400 U1)/
      expect(text).toMatch(pause)
      expect(text).toMatch(/\nM600/)
      const at = (needle: RegExp) => text.slice(0, text.search(needle)).split(/;LAYER_CHANGE|; CHANGE_LAYER/).length - 1
      expect(at(pause)).toBeLessThan(at(/\nM600/))
      expect(at(/\nM600/)).toBeLessThan(at(/M117 Swap the lid/))
      // A mark is removed from its own menu.
      await page.locator('.layer-mark').first().click()
      await page.getByRole('menuitem', { name: 'Remove pause' }).click()
      await expect(page.locator('.layer-mark')).toHaveCount(2)
    } finally {
      await patch(page, { layerMarks: {} })
    }
  })

  for (const printer of [
    { name: 'Bay 2', model: 'Bambu Lab P1S', start: 'machine: P1S-0.4' },
    { name: 'Bay 3', model: 'Prusa MK4S', start: 'M862.1 P' },
    { name: 'Bay 5', model: 'Creality K1 Max', start: 'START_PRINT EXTRUDER_TEMP' },
  ]) {
    test(`${printer.model}: the stock presets slice with no lint errors and the maker start G-code is in the file`, async ({ page }) => {
      test.slow()
      await calm(page)
      await plain(page)
      await liveLayered(page)
      await page.getByTestId('slice-machine-printer').click()
      await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: new RegExp(printer.name) }).click()
      await expect(page.locator('.printer-name')).toContainText(printer.name)
      await sliceDone(page)
      // No warning about the G-code: the linter let the shipped text through.
      await expect(page.locator('.warns li').filter({ hasText: /G-code|lint|blocked|refused/i })).toHaveCount(0)
      const text = await exportedGcode(page)
      // near the top of what runs, past the thumbnails (their size follows the printer's thumbnail list, not the G-code)
      expect(withoutThumbnails(executable(text)).slice(0, 20_000)).toContain(printer.start)
    })
  }

  test('the nozzle size is chosen per printer from its chip, and the slice uses the matching presets', async ({ page }) => {
    test.slow()
    await calm(page)
    await plain(page)
    await liveLayered(page)
    try {
      const chip = page.getByTestId('slice-machine-nozzle')
      await expect(chip).toHaveAttribute('aria-label', 'Nozzle: 0.4 mm')
      await chip.click()
      const sizes = page.getByRole('radiogroup', { name: 'Nozzle size' })
      await expect(sizes.getByRole('radio', { name: '0.4 mm' })).toHaveAttribute('aria-checked', 'true')
      await sizes.getByRole('radio', { name: '0.6 mm' }).click()
      await expect(chip).toHaveAttribute('aria-label', 'Nozzle: 0.6 mm')
      await sliceDone(page)
      const text = await exportedGcode(page)
      // The 0.6 mm nozzle's lines: 1.05 times the nozzle, not the 0.42 of a 0.4 mm nozzle.
      expect(text.slice(0, text.length - executable(text).length || 1500)).toMatch(/^; line_width = 0\.6\d/m)
      // The choice stays after a reload. The page's own notes (the plate it started with) go with the old document.
      await page.reload()
      await plateReady(page)
      await debugHooks(page)
      await tab(page, 'prepare').click()
      await expect(page.getByTestId('slice-machine-nozzle')).toHaveAttribute('aria-label', 'Nozzle: 0.6 mm')
    } finally {
      await patch(page, { printerNozzles: {} })
    }
  })

  test('brim ears: click the model to add ears, they print as discs on the first layer, and remove all clears them', async ({ page }) => {
    test.slow()
    await calm(page)
    await plain(page)
    await liveLayered(page)
    try {
      // The brim type is painted; the tool appears with it.
      await page.keyboard.press('ControlOrMeta+k')
      await page.locator('.sx-palette-input').fill('brim type')
      await page.locator('.sx-palette-item', { hasText: 'now' }).first().click()
      await expect(page.locator('#expert-panel')).toBeVisible()
      await page.locator('#expert-panel').getByLabel('Brim type').selectOption('painted')
      await page.locator('.obj-name', { hasText: 'Layered X' }).click()
      const toolbar = page.getByRole('toolbar', { name: 'Plate tools' })
      await toolbar.getByRole('button', { name: 'Brim ears' }).click()
      const panel = page.locator('[data-section=brim-ears]')
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/No ears yet/)
      await panesSettled(page)
      const vp = page.locator('.vp-canvas').first()
      const box = (await vp.boundingBox())!
      await pressable(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/1 ear/)
      // A click inside the footprint prints nothing (the ear is cut by the part). A second ear goes on the model's left edge,
      // sent through the viewport's own event, so it is the same path as a click there.
      await page.evaluate(() => {
        const w = window as unknown as { __sx: { getState(): { plate: { id: string; transform: number[]; parts: { positions: Float32Array }[] }[] } }; __vp: { emit(e: string, p: unknown): void } }
        const o = w.__sx.getState().plate[0]!
        const m = o.transform
        let minX = Infinity
        let y = 0
        let n = 0
        for (const part of o.parts) for (let i = 0; i + 2 < part.positions.length; i += 3) {
          const px = part.positions[i]!
          const py = part.positions[i + 1]!
          const pz = part.positions[i + 2]!
          const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!
          if (x < minX) minX = x
          y += m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!
          n++
        }
        w.__vp.emit('brimadd', { objectId: o.id, point: [minX, y / n, 0] })
      })
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/2 ears/)
      // Select all, remove the selected ones, then Auto-generate puts ears on the corners of the first layer.
      await panel.getByRole('button', { name: 'Select all' }).click()
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/2 selected/)
      await panel.getByRole('button', { name: 'Remove selected' }).click()
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/No ears yet/)
      await panel.getByRole('button', { name: 'Auto-generate' }).click()
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/\d+ ears?/)
      const generated = Number(/(\d+) ear/.exec((await panel.getByTestId('brim-ear-count').textContent()) ?? '')?.[1])
      expect(generated).toBeGreaterThanOrEqual(3)
      // A click on an ear selects it (the viewport's brimselect event), and Delete removes the ear, not the object.
      await page.evaluate(() => {
        const w = window as unknown as { __sx: { getState(): { selection: string } }; __vp: { emit(e: string, p: unknown): void } }
        w.__vp.emit('brimselect', { objectId: w.__sx.getState().selection, indices: [0], mode: 'set' })
      })
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/1 selected/)
      await page.keyboard.press('Delete')
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(new RegExp(`${generated - 1} ears?`))
      // The object stays: the tool holds the card, so the plate is read from the store.
      expect((await state(page)).plate.length).toBe(1)
      await sliceDone(page)
      const text = await exportedGcode(page)
      const mark = text.includes('\n; CHANGE_LAYER\n') ? '; CHANGE_LAYER' : ';LAYER_CHANGE'
      const firstLayer = text.slice(text.indexOf(mark), text.indexOf(mark, text.indexOf(mark) + 1))
      expect(firstLayer).toMatch(/;\s*(?:TYPE|FEATURE):\s*Brim/)
      // Remove all clears them. The slice showed the toolpaths and ended the brim tool; open it again.
      await tab(page, 'prepare').click()
      await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Brim ears' }).click()
      await panel.getByRole('button', { name: 'Remove all' }).click()
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/No ears yet/)
    } finally {
      await patch(page, { overrides: {}, objectTool: null, expertOpen: false })
    }
  })

  test('the G-code carries the real date and local time: the date variables in the start G-code are not 1970', async ({ page }) => {
    test.slow()
    await calm(page)
    await plain(page)
    await liveLayered(page)
    try {
      // Printers such as the Creality K2 Plus write the date in their start G-code ([year] to [second]); a comment line does the same here.
      await patch(page, { overrides: { machine_start_gcode: '; stamp [year]-[month]-[day] at [hour]:[minute]:[second]\nG28' } })
      const stamp = () => page.evaluate(() => {
        const d = new Date()
        return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours() }
      })
      const before = await stamp()
      await sliceDone(page)
      const after = await stamp()
      const text = await exportedGcode(page)
      const m = /; stamp (\d+)-(\d+)-(\d+) at (\d+):(\d+):(\d+)/.exec(executable(text).slice(0, 20_000))
      expect(m, 'the start G-code has the stamp line').not.toBeNull()
      const [year, month, day, hour] = [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])]
      expect(year).toBeGreaterThanOrEqual(before.year)
      expect(year).toBeLessThanOrEqual(after.year)
      // The slice happened between the two readings, so the date and local hour are one of the two.
      expect([before.month, after.month]).toContain(month)
      expect([before.day, after.day]).toContain(day)
      expect([before.hour, after.hour]).toContain(hour)
    } finally {
      await patch(page, { overrides: {} })
    }
  })

  // The prime tower and the tool changes of a two-color plate on a Bambu Lab printer (the plate.spec test of that name)
  // are checked by 'a two-color plate keeps its prime tower and the filament order reaches the G-code' above; the flush
  // matrix values are in packages/app/test/filament.test.ts.
})
