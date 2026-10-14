// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pause, color change and custom G-code pins on the playback bar's Layer slider: where they sit, how crowded ones
// step into lanes, a right-click landing on a layer, a pin click jumping there, and the bar's height and folded row.
import { type Locator, type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

type Sx = { getState(): Record<string, unknown> & { preview: { layerZ: ArrayLike<number>; layerCount: number } | null; layerHi: number; activePlate: string; layerMarks: Record<string, { z: number; kind: string }[]> }; setState(p: unknown): void }

async function sliced(page: Page): Promise<Locator> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
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

/** Marks at these layers (1-based), straight into the store. */
async function marks(page: Page, list: [number, string][]): Promise<void> {
  await page.evaluate((list) => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    const s = sx.getState()
    const z = s.preview!.layerZ
    sx.setState({ layerMarks: { [s.activePlate]: list.map(([l, kind], i) => ({ id: `m${i}`, z: Math.round(z[l - 1]! * 1e4) / 1e4, kind, ...(kind === 'custom' ? { gcode: 'M117 Hi' } : {}) })) } })
  }, list)
  await expect(page.locator('.layer-mark:not(.strike-mark)')).toHaveCount(list.length)
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const layerHi = async (page: Page) => (await state(page)).layerHi

/** Where the slider's thumb center sits at `layer`, from the track box (a 13 px thumb). */
async function thumbX(page: Page, layer: number): Promise<number> {
  const b = (await page.locator('#pv-layer').boundingBox())!
  const n = (await state(page)).preview!.layerCount
  return b.x + 6.5 + ((layer - 1) / (n - 1)) * (b.width - 13)
}

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
      const stem = await pin.evaluate((el) => parseFloat(getComputedStyle(el, '::after').height))
      expect(b.y + b.height + stem).toBeGreaterThanOrEqual(track.y + track.height / 2 - 2)
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
    await expect(pin).toHaveAttribute('aria-label', 'Layer 100, Pause')
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
