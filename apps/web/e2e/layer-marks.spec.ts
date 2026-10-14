// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pause, color change and custom G-code pins on the playback bar's Layer slider: where they sit, how crowded ones
// step into lanes and past three share a "+N" pin, a right-click landing on a layer, a pin click jumping there by the
// pin's own mark, the typed layer number, touch on a phone, the filament slot note through a saved project, and the
// bar's height and folded row.
import { type Locator, type Page } from '@playwright/test'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'
import { addMenu, expect, plateReady, sliceCount, sliced as slicedNow, test } from './fixtures'

type Mark = { id: string; z: number; kind: string; slot?: number; gcode?: string }
type Sx = { getState(): Record<string, unknown> & { preview: { layerZ: ArrayLike<number>; layerCount: number } | null; layerHi: number; activePlate: string; layerMarks: Record<string, Mark[]>; slice: { status: string; stale?: boolean; result?: { id: string } } }; setState(p: unknown): void }

/** Slices the example plate, with `overrides` set first, and returns the playback bar. */
async function sliced(page: Page, overrides?: Record<string, string>, slots?: Record<number, { type: string; brand: string; color: string }>): Promise<Locator> {
  interceptFileDialogs(page)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  if (overrides || slots) await page.evaluate(([o, sl]) => (window as unknown as { __sx: Sx }).__sx.setState({ ...(o ? { overrides: o } : {}), ...(sl ? { slotSetup: sl } : {}) }), [overrides, slots] as const)
  const slice = page.getByRole('button', { name: 'Slice plate' })
  if (await slice.isVisible()) await slice.click()
  else {
    await page.mouse.click(300, 250)
    await page.keyboard.press('ControlOrMeta+Enter')
  }
  const dock = page.getByRole('group', { name: 'Layers and moves' })
  await expect(dock).toBeVisible({ timeout: 60_000 })
  return dock
}

/**
 * Marks at these layers (1-based), straight into the store; a third value `below` puts the mark that far under the
 * layer's top, so it still shows on that layer. `heads` is how many pins show, when some share a "+N" pin.
 */
async function marks(page: Page, list: ([number, string] | [number, string, number])[], heads = list.length): Promise<void> {
  await page.evaluate((list) => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    const s = sx.getState()
    const z = s.preview!.layerZ
    sx.setState({ layerMarks: { [s.activePlate]: list.map(([l, kind, below], i) => ({ id: `m${i}`, z: Math.round((z[l - 1]! - (below ?? 0)) * 1e4) / 1e4, kind, ...(kind === 'custom' ? { gcode: 'M117 Hi' } : {}) })).sort((a, b) => a.z - b.z) } })
  }, list)
  await expect(page.locator('.layer-mark:not(.strike-mark)')).toHaveCount(heads)
}

/** The pin for one mark, by the start of its accessible name ("Pause at layer 20"). */
const pin = (page: Page, name: string) => page.locator(`.layer-mark:not(.strike-mark)[aria-label^="${name},"]`)
const center = async (l: Locator) => {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const layerHi = async (page: Page) => (await state(page)).layerHi

/** Where the slider's thumb center sits at `layer`, from the track box (a 13 px thumb). */
/** The same, on a whole pixel: a mouse event's position reaches the page in whole pixels. */
const slotX = async (page: Page, layer: number) => Math.round(await thumbX(page, layer))
async function thumbX(page: Page, layer: number): Promise<number> {
  const b = (await page.locator('#pv-layer').boundingBox())!
  const n = (await state(page)).preview!.layerCount
  return b.x + 6.5 + ((layer - 1) / (n - 1)) * (b.width - 13)
}

/** Boxes of the bar's controls and of what sits above it, leaving out the pins and the layer slider's own thumb. */
/** Every pin's head, and its stem as the boxes it is drawn with: the line under the head, then the foot's two edges. */
async function pinParts(page: Page): Promise<{ head: Box; stem: Box[]; foot: number }[]> {
  return page.locator('.layer-mark:not(.strike-mark)').evaluateAll((els) =>
    els.map((el) => {
      const h = el.getBoundingClientRect()
      const leg = el.querySelector('.layer-mark-leg')!.getBoundingClientRect()
      const line = parseFloat(getComputedStyle(el, '::after').height)
      const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
      return {
        head: box(h.x, h.y, h.width, h.height),
        stem: [box(h.x + h.width / 2 - 1, h.bottom, 2, line), box(leg.x, leg.y, leg.width, 2), box(leg.x, leg.y, 2, leg.height)],
        foot: leg.x + 1,
      }
    }),
  )
}
type Box = { x: number; y: number; width: number; height: number }
/** The space between two boxes: negative when they overlap on both axes. */
const apart = (a: Box, b: Box) => Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), a.y - (b.y + b.height), b.y - (a.y + a.height))

/**
 * No stem runs through another pin's head, no two stems cross, and heads keep 2 px apart. Marks on layers closer than a
 * stem's 2 px width share one line where they meet the track, so their feet may touch there, low under the elbows.
 */
async function expectPinsClear(page: Page): Promise<void> {
  const parts = await pinParts(page)
  const track = (await page.locator('#pv-layer').boundingBox())!
  const low = track.y + track.height / 2 - 9.5
  for (const [i, p] of parts.entries())
    for (const [j, q] of parts.entries()) {
      if (i === j) continue
      const shared = Math.abs(p.foot - q.foot) < 2
      for (const s of p.stem) {
        expect(apart(s, q.head), `stem ${i} against head ${j}`).toBeGreaterThan(0)
        // where two such feet meet, the top of the overlap is low over the track
        for (const t of q.stem) if (!(shared && Math.max(s.y, t.y) >= low)) expect(apart(s, t), `stems ${i} and ${j}`).toBeGreaterThan(0)
      }
      if (i < j) expect(apart(p.head, q.head), `heads ${i} and ${j}`).toBeGreaterThanOrEqual(2 - 0.01)
    }
}

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

test.describe('layer pins', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop bar; the phone has its own case below')

  test('pins stand on stems over their layer, clear of the Time and Moves tracks, with tips above', async ({ page }) => {
    await sliced(page)
    await marks(page, [[5, 'pause'], [120, 'color_change'], [250, 'custom']])
    const time = (await page.locator('#pv-time').boundingBox())!
    const track = (await page.locator('#pv-layer').boundingBox())!
    const moves = (await page.locator('#pv-moves').boundingBox())!
    for (const [i, layer] of [5, 120, 250].entries()) {
      const pin = page.locator('.layer-mark:not(.strike-mark)').nth(i)
      const b = (await pin.boundingBox())!
      // over the layer's slot, within a pixel of where the thumb stands at that layer
      expect(Math.abs(b.x + b.width / 2 - (await thumbX(page, layer)))).toBeLessThan(1.01)
      // the head is above the track, and its stem reaches down to the track's line
      expect(b.y + b.height).toBeLessThanOrEqual(track.y + 0.5)
      const foot = (await pin.locator('.layer-mark-leg').boundingBox())!
      expect(foot.y + foot.height).toBeGreaterThanOrEqual(track.y + track.height / 2 - 2)
      // never over the Moves track, and clear of the Time track's thumb
      expect(b.y + b.height).toBeLessThan(moves.y)
      expect(b.y).toBeGreaterThanOrEqual(time.y + time.height)
    }
    const pin = page.locator('.layer-mark:not(.strike-mark)').nth(1)
    await pin.hover()
    const tip = page.getByRole('tooltip').filter({ hasText: 'Layer 120, Color change' })
    await expect(tip).toBeVisible()
    const pinTop = (await pin.boundingBox())!.y
    await expect.poll(async () => { const t = (await tip.boundingBox())!; return t.y + t.height }).toBeLessThanOrEqual(pinTop + 0.5)
  })

  test('crowded pins step up into lanes and keep apart', async ({ page }) => {
    await sliced(page)
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom'], [150, 'pause']])
    const pins = page.locator('.layer-mark:not(.strike-mark)')
    expect(await pins.evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')))).toEqual(['0', '1', '2', '0'])
    const boxes = await Promise.all([0, 1, 2].map(async (i) => (await pins.nth(i).boundingBox())!))
    for (let i = 0; i < 2; i++) expect(boxes[i + 1]!.y + boxes[i + 1]!.height).toBeLessThanOrEqual(boxes[i]!.y)
    const time = (await page.locator('#pv-time').boundingBox())!
    expect(boxes[2]!.y).toBeGreaterThanOrEqual(time.y + time.height)
    await expectPinsClear(page)
    // a pin just left of the crowd and two far ones: still no stem through a head, and heads apart
    await marks(page, [[5, 'pause'], [20, 'color_change'], [21, 'pause'], [22, 'custom'], [120, 'custom'], [250, 'color_change']], 5)
    await expectPinsClear(page)
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom'], [150, 'pause']])
    // each one is its own click
    await pins.nth(2).click()
    await expect.poll(() => layerHi(page)).toBe(22)
    await expect(page.getByRole('menuitem', { name: 'Remove custom G-code' })).toBeVisible()
  })

  test('a right-click on the track lands on the layer under the pointer, and a pin click jumps back to it', async ({ page }) => {
    await sliced(page)
    const x = await thumbX(page, 100)
    const track = (await page.locator('#pv-layer').boundingBox())!
    // a little off the slot still lands on it
    await page.mouse.click(x + 0.4, track.y + track.height / 2, { button: 'right' })
    await expect.poll(() => layerHi(page)).toBe(100)
    await page.getByRole('menuitem', { name: 'Add pause' }).click()
    const s = await state(page)
    expect(s.layerMarks[s.activePlate]![0]!.z).toBeCloseTo(s.preview!.layerZ[99]!, 4)
    const pin = page.locator('.layer-mark:not(.strike-mark)')
    await expect(pin).toHaveAttribute('aria-label', /^Pause at layer 100, \d+\.\d\d mm$/)
    // somewhere else, then the pin: it jumps back the way a typed layer does, and its menu offers to remove it
    await page.locator('#pv-layer').focus()
    await page.keyboard.press('End')
    await expect.poll(() => layerHi(page)).not.toBe(100)
    await pin.click()
    await expect.poll(() => layerHi(page)).toBe(100)
    await expect(page.getByRole('menuitem', { name: 'Remove pause' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Remove pause' }).click()
    await expect(pin).toHaveCount(0)
  })

  test('the layer number is typed in: Enter goes there, Esc puts it back', async ({ page }) => {
    await sliced(page)
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
    const dock = await sliced(page)
    // the right pane opens with the slice, so the bar is under 1000 px: one control row
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
    // a big screen: with both side panes open the bar is still over 1000 px
    await page.setViewportSize({ width: 1920, height: 1080 })
    const dock = await sliced(page)
    await expect.poll(async () => (await dock.boundingBox())!.width).toBeGreaterThanOrEqual(1000)
    await expect(dock).not.toHaveAttribute('data-narrow', 'true')
    await expect(dock.locator('.dock-h2')).toBeVisible()
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom']])
    const time = (await page.locator('#pv-time').boundingBox())!
    const top = (await page.locator('.layer-mark[data-lane="2"]').boundingBox())!
    expect(top.y).toBeGreaterThanOrEqual(time.y + time.height)
  })

  test('opening the bar, a pin click and a layer change move nothing beside or above them', async ({ page }) => {
    await sliced(page)
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
    const dock = await sliced(page)
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
      const pins = [...document.querySelectorAll<HTMLElement>('.layer-mark[data-ids]')].map((el) => { const r = el.getBoundingClientRect(); return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 } })
      const p20 = pins.find((p) => p.el.getAttribute('aria-label')!.startsWith('Pause at layer 20'))!
      for (let dy = -16; dy <= 16; dy++)
        for (let dx = -16; dx <= 16; dx++) {
          const x = Math.round(p20.x) + dx
          const y = Math.round(p20.y) + dy
          const top = document.elementFromPoint(x, y)?.closest<HTMLElement>('.layer-mark[data-ids]')
          if (!top) continue
          const near = pins.slice().sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0]!
          if (near.el !== top && (near === p20 || top === p20.el)) return { x, y, top: top.getAttribute('aria-label')!, near: near.el.getAttribute('aria-label')!, layer: Number(near.el.dataset.layer) }
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
    const left = (await state(page)).layerMarks[(await state(page)).activePlate]!.map((m) => m.id)
    expect(left).toEqual(['m0', 'm1', 'm3'])
  })

  test('two marks on one layer are two pins, each with its own menu', async ({ page }) => {
    await sliced(page)
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
    await sliced(page)
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom'], [23, 'pause'], [24, 'color_change'], [150, 'pause']], 4)
    const group = page.locator('.layer-mark[data-kind="group"]')
    await expect(group).toHaveCount(1)
    await expect(group).toHaveText('+3')
    await expect(group).toHaveAttribute('aria-label', '3 layer actions, layers 22 to 24')
    // inside the three-lane band, under nothing
    const time = (await page.locator('#pv-time').boundingBox())!
    expect((await group.boundingBox())!.y).toBeGreaterThanOrEqual(time.y + time.height)
    await expectPinsClear(page)
    const lanes = () => page.locator('.layer-mark:not(.strike-mark)').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-ids')}:${e.getAttribute('data-lane')}`))
    const before = await lanes()
    expect(before).toEqual(['m0:0', 'm1:1', 'm2 m3 m4:2', 'm5:0'])
    await group.click()
    const list = page.getByRole('menu', { name: 'Layer actions near layer 22' })
    await expect(list.getByRole('menuitem', { name: / at layer / })).toHaveText([/^Custom G-code at layer 22, /, /^Pause at layer 23, /, /^Color change at layer 24, /])
    await list.getByRole('menuitem', { name: /^Pause at layer 23/ }).click()
    await expect.poll(() => layerHi(page)).toBe(23)
    await expect(page.getByRole('menu', { name: 'Pause at layer 23' }).getByRole('menuitem', { name: 'Remove pause' })).toBeVisible()
    await page.keyboard.press('Escape')
    // a rerender, a layer change and a mark far off leave every lane as it was
    await page.locator('#pv-layer').fill('200')
    await marks(page, [[20, 'pause'], [21, 'color_change'], [22, 'custom'], [23, 'pause'], [24, 'color_change'], [150, 'pause'], [260, 'custom']], 5)
    expect((await lanes()).slice(0, 4)).toEqual(before)
  })

  test('the keyboard reaches each pin with its tip, and Escape shuts a menu back to what opened it', async ({ page }) => {
    await sliced(page)
    await marks(page, [[20, 'pause'], [21, 'color_change']])
    await page.locator('#pv-layer').focus()
    await page.keyboard.press('Tab')
    const first = pin(page, 'Pause at layer 20')
    await expect(first).toBeFocused()
    await expect(page.getByRole('tooltip').filter({ hasText: 'Layer 20, Pause' })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(pin(page, 'Color change at layer 21')).toBeFocused()
    await expect(page.getByRole('tooltip').filter({ hasText: 'Layer 21, Color change' })).toBeVisible()
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

  test('the typed layer number takes only a layer or a height, and keys typed there drive nothing else', async ({ page }) => {
    const dock = await sliced(page)
    const n = (await state(page)).preview!.layerCount
    await page.locator('#pv-layer').fill('30')
    const field = page.getByTestId('pv-layer-jump')
    const open = async () => {
      await page.locator('.dock-jump-num').click()
      await expect(field).toBeFocused()
    }
    // refused, the field stays open and marked, and the layer stays
    for (const bad of ['', '   ', 'abc', '-3', '4.5', '1e3', '12 layers']) {
      await open()
      await field.fill(bad)
      await field.press('Enter')
      await expect(field, bad).toHaveAttribute('aria-invalid', 'true')
      expect(await layerHi(page), bad).toBe(30)
      await field.press('Escape')
      await expect(field).toBeHidden()
    }
    // past the ends, the first or last layer
    for (const [text, want] of [['0', 1], ['99999', n], [String(n), n], ['z-5', 1], ['999 mm', n], ['1', 1], [' 42 ', 42]] as const) {
      await open()
      await field.fill(text)
      await field.press('Enter')
      await expect(field, text).toBeHidden()
      await expect.poll(() => layerHi(page), text).toBe(want)
      await expect(page.locator('.dock-jump-num')).toHaveText(String(want))
    }
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

  test('layers of different heights: a right-click lands on a sliced layer at both ends, and a new layer count clamps', async ({ page }) => {
    // a thick first layer under thinner ones, which the layer plan may vary further: the heights are not one step apart
    const dock = await sliced(page, { initial_layer_print_height: '0.3' })
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
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ overrides: { initial_layer_print_height: '0.3', layer_height: '0.28', smart_layer: 'off' } }))
    const count = await sliceCount(page)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(slicedNow(page, count)).toBeVisible({ timeout: 120_000 })
    const m = (await state(page)).preview!.layerCount
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

  test('the bar folds by its own width: either side of 1000 px and of the 900 px window, with no flicker', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    const dock = await sliced(page)
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
      if (phone) await expect(dock).toHaveAttribute('data-phone', 'true')
      else await expect(dock).not.toHaveAttribute('data-phone', 'true')
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
    await page.addInitScript(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
    await sliced(page, undefined, SLOTS)
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
    await expect(slicedNow(page)).toHaveCount(0)
    const count = await sliceCount(page)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(slicedNow(page, count)).toBeVisible({ timeout: 120_000 })
    const fs = await import('node:fs')
    const exportGcode = async () => {
      await page.keyboard.press('ControlOrMeta+k')
      await page.keyboard.type('Export G-code')
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.sx-palette-item', { hasText: /^Export G-code/ }).first().click()])
      return fs.readFileSync(await download.path(), 'utf8')
    }
    const before = await exportGcode()
    expect(before).toMatch(/\nM600/)
    const slice = (await state(page)).slice.result!.id
    // the note changes to slot 2: the slice stays current, nothing slices again, and the same G-code goes out
    await change.click()
    await page.getByRole('menu', { name: 'Color change at layer 40' }).getByRole('menuitemcheckbox', { name: /Slot 2/ }).click()
    await expect(change).toHaveCSS('background-color', 'rgb(48, 164, 108)')
    await expect(slicedNow(page)).toBeVisible()
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
  })

  test('the slot note survives a saved project opened in a fresh browser, and a slot not loaded there says so', async ({ page, browser }) => {
    test.slow()
    await page.addInitScript(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
    await sliced(page, undefined, SLOTS)
    await colorChange(page, 40, 3)
    await colorChange(page, 80, 4)
    // saved from the Export menu, as a person saves
    await addMenu(page, 'Export')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
    expect(download.suggestedFilename()).toMatch(/\.sx3mf$/)
    const fs = await import('node:fs')
    const saved = fs.readFileSync(await download.path())
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL! })
    const again = await fresh.newPage()
    try {
      // nothing from the first browser: its own storage, its own project
      interceptFileDialogs(again)
      await again.addInitScript(() => {
        if (sessionStorage.getItem('sx-e2e')) return
        sessionStorage.setItem('sx-e2e', '1')
        localStorage.setItem('slicerx.debug', '1')
        localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
      })
      await again.goto('./')
      await plateReady(again)
      const marksNow = () => again.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return (s.layerMarks[s.activePlate] ?? []).map((m) => `${m.kind}:${m.slot ?? ''}`) })
      expect(await marksNow()).toEqual([])
      const chooser = await expectFileDialog(again, () => again.keyboard.press('ControlOrMeta+o'))
      await chooser.setFiles({ name: 'Slot note.sx3mf', mimeType: 'model/3mf', buffer: saved })
      await expect.poll(marksNow, { timeout: 60_000 }).toEqual(['color_change:3', 'color_change:4'])
      // a printer with fewer slots: slot 4 is kept, and its menu says it is not loaded
      await again.evaluate(() => { const sx = (window as unknown as { __sx: Sx }).__sx; sx.setState({ slotSetup: { 1: { type: 'PLA', brand: '', color: '#E5484D' }, 2: { type: 'PETG', brand: '', color: '#30A46C' } }, printerSlots: [] }) })
      const count = await sliceCount(again)
      const slice = again.getByRole('button', { name: 'Slice plate' })
      if (await slice.isVisible()) await slice.click()
      else await again.keyboard.press('ControlOrMeta+Enter')
      await expect(slicedNow(again, count)).toBeVisible({ timeout: 120_000 })
      const four = pin(again, 'Color change at layer 80')
      await expect(four).toHaveAttribute('data-tip-body', /Slot 4, not loaded now/)
      await four.click()
      const menu = again.getByRole('menu', { name: 'Color change at layer 80' })
      await expect(menu.getByRole('menuitemcheckbox', { name: /Slot 4/ })).toHaveAttribute('aria-checked', 'true')
      await expect(menu.getByRole('menuitemcheckbox', { name: /Slot 4/ })).toBeDisabled()
      await expect(menu.getByRole('menuitemcheckbox', { name: /Slot 4/ })).toContainText('not loaded')
      expect(await marksNow()).toEqual(['color_change:3', 'color_change:4'])
    } finally {
      await fresh.close()
    }
  })
})

/** A real finger tap: down for 60 ms through the browser's touch input, as a person's is. */
async function tap(page: Page, at: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
  await page.waitForTimeout(60)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

test('on a phone each pin is its own tap, close ones open a list, and More and the slider keep their taps', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone layout')
  await sliced(page)
  // Chromium's touch hit test wakes on the page's first mouse event
  await page.mouse.click(1, 1)
  const more = page.getByRole('button', { name: 'More playback controls' })
  await tap(page, await center(more))
  await expect(page.getByRole('button', { name: 'Fewer playback controls' })).toBeVisible()
  const z = (await state(page)).preview!.layerZ
  const below = Math.round(((z[19]! - z[18]!) / 2) * 1e4) / 1e4
  await marks(page, [[20, 'pause'], [20, 'color_change', below], [21, 'custom'], [200, 'pause']])
  // each head under a finger is that mark: its layer, its own menu, the pin marked, the menu inside the screen
  for (const [name, layer, item] of [
    ['Pause at layer 200', 200, 'Remove pause'],
    ['Color change at layer 20', 20, 'Remove color change'],
    ['Pause at layer 20', 20, 'Remove pause'],
    ['Custom G-code at layer 21', 21, 'Remove custom G-code'],
  ] as const) {
    const p = pin(page, name)
    await tap(page, await center(p))
    await expect.poll(() => layerHi(page), name).toBe(layer)
    const menu = page.getByRole('menu', { name })
    await expect(menu, name).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: item })).toBeVisible()
    await expect(p).toHaveAttribute('data-selected', 'true')
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(844)
    await page.keyboard.press('Escape')
  }
  // a finger between the two layer 20 heads could mean either: a list of both, and a tap on one opens its menu
  const a = await center(pin(page, 'Pause at layer 20'))
  const b = await center(pin(page, 'Color change at layer 20'))
  await tap(page, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const list = page.getByRole('menu', { name: 'Layer actions near layer 20' })
  // both layer 20 marks, in layer order (a neighbor near the finger may join them)
  await expect(list.getByRole('menuitem', { name: / at layer / }).first()).toHaveText(/ at layer 20, /)
  await expect(list.getByRole('menuitem', { name: /^Pause at layer 20/ })).toBeVisible()
  await expect(list.getByRole('menuitem', { name: /^Color change at layer 20/ })).toBeVisible()
  await tap(page, await center(list.getByRole('menuitem', { name: /^Color change at layer 20/ })))
  await expect(page.getByRole('menu', { name: 'Color change at layer 20' }).getByRole('menuitem', { name: 'Remove color change' })).toBeVisible()
  await page.keyboard.press('Escape')
  // a drag on the slider scrubs: no pin takes it and no menu opens
  const track = (await page.locator('#pv-layer').boundingBox())!
  const n = (await state(page)).preview!.layerCount
  const from = { x: await thumbX(page, await layerHi(page)), y: track.y + track.height / 2 }
  const to = { x: await thumbX(page, Math.round(n * 0.75)), y: from.y }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  for (let t = 1; t <= 8; t++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * t) / 8, y: from.y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await expect.poll(() => layerHi(page)).toBeGreaterThan(Math.round(n * 0.6))
  await expect(page.getByRole('menu')).toHaveCount(0)
  // and More still answers its own tap
  await tap(page, await center(page.getByRole('button', { name: 'Fewer playback controls' })))
  await expect(page.getByRole('button', { name: 'More playback controls' })).toBeVisible()
})

test('on a phone the pins stand over the Layer track in the opened bar', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone layout')
  await sliced(page)
  await page.getByRole('button', { name: 'More playback controls' }).click()
  await marks(page, [[20, 'pause'], [21, 'color_change'], [200, 'custom']])
  const time = (await page.locator('#pv-time').boundingBox())!
  const track = (await page.locator('#pv-layer').boundingBox())!
  for (const b of await page.locator('.layer-mark:not(.strike-mark)').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(b.y + b.height).toBeLessThanOrEqual(track.y + 0.5)
    expect(b.y).toBeGreaterThanOrEqual(time.y + time.height)
  }
})
