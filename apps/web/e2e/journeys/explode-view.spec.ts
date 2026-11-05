// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The exploded view: with an object of several parts selected, the Spread control over the view draws its parts moved
// apart, in Prepare and in Model. It is display only (the object's transform and the plate stay as they were), the
// axis options never move the control, it hides for a single part and goes back to 0 when the selection changes.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { appState, exploded, openAssembly, setApp } from '../explode-project'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { settledView, useFileDialogs } from './lib/model'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, autoSliceBySize: false } })
test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')
useFileDialogs()

/** Where the control and its parts sit, rounded to whole pixels. */
async function layout(page: Page): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {}
  for (const [k, sel] of Object.entries({ bar: '[data-testid="explode-bar"]', slider: '#explode-spread', radial: '[data-testid="explode-axis-radial"]', z: '[data-testid="explode-axis-z"]', look: '.hud-top .hud-row .sx-btn' })) {
    const b = await page.locator(sel).first().boundingBox()
    out[k] = b ? [b.x, b.y, b.width, b.height].map(Math.round) : []
  }
  return out
}

/** With SX_SHOTS (and SX_SHOTS_DIR for where), the view at 0 and 60 percent in dark and light. */
async function shots(page: Page, name: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  const dir = process.env['SX_SHOTS_DIR'] ?? test.info().outputPath()
  mkdirSync(dir, { recursive: true })
  for (const scheme of ['dark', 'light'] as const) {
    await setApp(page, { scheme, themeFollowsSystem: false })
    for (const spread of [0, 60]) {
      await page.locator('#explode-spread').fill(String(spread))
      // no tooltip from the last press, and in Model the view framed on the spread parts
      await page.mouse.move(2, 2)
      if (name.startsWith('model')) await page.evaluate(() => (window as unknown as { __vp: { frameSelection(o: unknown): void } }).__vp.frameSelection({ animate: false }))
      await settledView(page)
      await page.screenshot({ path: join(dir, `${name}-${spread}-${scheme}.png`) })
    }
  }
  await setApp(page, { scheme: 'dark' })
}


/** The assembly's lowest point over the bed from its real parts and transform, and a spot on the base's top, bed mm. */
async function trueGeometry(page: Page, id: string): Promise<{ minZ: number; baseEdge: [number, number, number] }> {
  return page.evaluate((id) => {
    const e = (window as unknown as { __sx: { getState(): { plate: { id: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }[] } } }).__sx.getState().plate.find((p) => p.id === id)!
    const m = e.transform
    const at = (x: number, y: number, z: number): [number, number, number] => [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
    let minZ = Infinity
    for (const p of e.parts) for (let i = 0; i + 2 < p.positions.length; i += 3) minZ = Math.min(minZ, at(p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!)[2])
    // on the base's top, 4 mm in from its front edge: the part X spread draws elsewhere
    const pos = e.parts[0]!.positions
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, pos[i + k]!); hi[k] = Math.max(hi[k]!, pos[i + k]!) }
    return { minZ, baseEdge: at((lo[0]! + hi[0]!) / 2, lo[1]! + 4, hi[2]!) }
  }, id)
}

type Vp = { screenOf(p: number[]): [number, number]; rotateHandles(): Partial<Record<'x' | 'y' | 'z', [number, number]>> | null; brim: { forEachEar(cb: (id: string, i: number, e: { x: number; y: number }) => void): void } }

test.describe('exploded view', () => {
  test('spreads the selected assembly in Prepare, display only, and the options never move', async ({ page }) => {
    const { assembly, single } = await openAssembly(page)
    const bar = page.getByTestId('explode-bar')
    await expect(bar).toBeVisible()
    const before = (await appState(page)).plate.find((p) => p.id === assembly)!.transform

    await page.locator('#explode-spread').fill('60')
    await expect(bar.locator('output')).toHaveText('60%')
    await expect.poll(async () => (await exploded(page))[assembly]?.length ?? 0).toBe(3)
    const radial = (await exploded(page))[assembly]!
    // the parts moved apart; the object and the plate did not
    expect(new Set(radial.map((o) => o.join(','))).size).toBe(3)
    expect((await appState(page)).plate.find((p) => p.id === assembly)!.transform).toEqual(before)

    // The bar sits under the plate toolbar, never beneath it.
    const bar0 = (await bar.boundingBox())!
    const tools = (await page.getByRole('toolbar', { name: 'Plate tools' }).boundingBox())!
    expect(bar0.y).toBeGreaterThanOrEqual(tools.y + tools.height)
    // Static controls: picking an axis keeps the bar, the slider, every option and the look button where they were.
    const at = await layout(page)
    await page.getByTestId('explode-axis-z').click()
    await expect(page.getByTestId('explode-axis-z')).toHaveAttribute('aria-checked', 'true')
    expect(await layout(page)).toEqual(at)
    await expect.poll(async () => (await exploded(page))[assembly]!.map((o) => o[2]! > 0).filter(Boolean).length).toBe(2)
    const z = (await exploded(page))[assembly]!
    for (const o of z) expect([o[0], o[1]]).toEqual([0, 0])
    await page.getByTestId('explode-axis-radial').click()
    expect(await layout(page)).toEqual(at)

    await shots(page, 'prepare-1440')

    // a single part has nothing to spread; a new selection puts the parts back
    await setApp(page, { selection: single, selectedIds: [single] })
    await expect(bar).toBeHidden()
    expect((await appState(page)).explode.spread).toBe(0)
    expect(await exploded(page)).toEqual({})
    await setApp(page, { selection: assembly, selectedIds: [assembly] })
    await expect(page.locator('#explode-spread')).toHaveValue('0')
  })

  test('spreads the selected assembly in Model too', async ({ page }) => {
    const { assembly } = await openAssembly(page)
    await setApp(page, { modelMode: 'design' })
    await setApp(page, { selection: assembly, selectedIds: [assembly] })
    const bar = page.getByTestId('explode-bar')
    await expect(bar).toBeVisible()
    await page.locator('#explode-spread').fill('60')
    await expect.poll(async () => (await exploded(page))[assembly]?.length ?? 0).toBe(3)
    await shots(page, 'model-1440')
    await setApp(page, { modelMode: 'slice' })
  })

  test('an edit tool puts the parts back first: a brim ear lands on the true part, a turn drops from true geometry', async ({ page }) => {
    const { assembly } = await openAssembly(page)
    // the Brim ears tool shows while the brim is painted
    const st = await appState(page)
    await setApp(page, { overrides: { ...(st as unknown as { overrides: object }).overrides, brim_type: 'painted' } })
    await page.getByTestId('explode-axis-x').click()
    await page.locator('#explode-spread').fill('60')
    await expect.poll(async () => (await exploded(page))[assembly]?.length ?? 0).toBe(3)
    // the base is drawn moved along X
    expect(Math.abs((await exploded(page))[assembly]![0]![0]!)).toBeGreaterThan(10)
    const toolbar = page.getByRole('toolbar', { name: 'Plate tools' })
    await toolbar.getByRole('button', { name: 'Brim ears' }).click()
    // spread goes to 0 and waits, with the hint under it; the bar does not move
    await expect(page.getByTestId('explode-hint')).toBeVisible()
    await expect(page.locator('#explode-spread')).toBeDisabled()
    expect((await appState(page)).explode.spread).toBe(0)
    expect(await exploded(page)).toEqual({})
    // a click on the base where it prints adds an ear there
    const { baseEdge } = await trueGeometry(page, assembly)
    const [sx, sy] = await page.evaluate((p) => (window as unknown as { __vp: Vp }).__vp.screenOf(p), baseEdge)
    await page.mouse.click(sx, sy)
    const ears = await page.evaluate(() => {
      const out: { x: number; y: number }[] = []
      ;(window as unknown as { __vp: Vp }).__vp.brim.forEachEar((_id, _i, e) => out.push({ x: e.x, y: e.y }))
      return out
    })
    expect(ears.length).toBeGreaterThan(0)
    const near = ears.some((e) => Math.hypot(e.x - baseEdge[0], e.y - baseEdge[1]) <= 6)
    expect(near, JSON.stringify({ ears, baseEdge })).toBe(true)
    await page.keyboard.press('Escape')
    const brim = toolbar.getByRole('button', { name: 'Brim ears' })
    if ((await brim.getAttribute('aria-pressed')) === 'true') await brim.click()
    await expect(brim).toHaveAttribute('aria-pressed', 'false')
    await setApp(page, { overrides: (st as unknown as { overrides: object }).overrides })

    // Rotate: a drag on a ring of a spread object starts from the parts where they print and ends on the bed.
    await setApp(page, { selection: assembly, selectedIds: [assembly] })
    await expect(page.locator('#explode-spread')).toBeEnabled()
    await page.getByTestId('explode-axis-z').click()
    await page.locator('#explode-spread').fill('100')
    await expect.poll(async () => (await exploded(page))[assembly]?.length ?? 0).toBe(3)
    const turnedFrom = (await appState(page)).plate.find((p) => p.id === assembly)!.transform
    await toolbar.getByRole('button', { name: 'Rotate' }).click()
    // a grab point on a tilted ring (about X or Y) that nothing over the view covers
    await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.rotateHandles() !== null)).toBe(true)
    // rotateHandles answers in pixels from the canvas corner
    const ring = await page.evaluate(() => {
      const h = (window as unknown as { __vp: Vp }).__vp.rotateHandles() ?? {}
      const c = document.querySelector('.vp-canvas')!.getBoundingClientRect()
      for (const k of ['x', 'y'] as const) {
        const p = h[k]
        if (!p) continue
        const at: [number, number] = [c.left + p[0], c.top + p[1]]
        if (document.elementFromPoint(at[0], at[1])?.tagName === 'CANVAS') return at
      }
      return null
    })
    expect(ring).not.toBeNull()
    await page.mouse.move(ring![0], ring![1])
    await page.mouse.down()
    // the press on the ring already puts the parts back where they print
    await expect.poll(async () => (await appState(page)).explode.spread).toBe(0)
    await page.mouse.move(ring![0] + 20, ring![1] + 30, { steps: 3 })
    await page.mouse.move(ring![0] + 40, ring![1] + 60, { steps: 3 })
    await page.mouse.up()
    expect((await appState(page)).explode.spread).toBe(0)
    expect(await exploded(page)).toEqual({})
    // it turned about a tilted axis (its own Z no longer points up) by more than a few degrees
    await expect.poll(async () => (await appState(page)).plate.find((p) => p.id === assembly)!.transform[10]!).toBeLessThan(Math.cos((5 * Math.PI) / 180))
    expect(turnedFrom[10]).toBeCloseTo(1)
    await expect.poll(async () => Math.abs((await trueGeometry(page, assembly)).minZ)).toBeLessThan(0.05)
    await toolbar.getByRole('button', { name: 'Rotate' }).click()
  })

  test('in Model, a click on a spread part picks its face where it prints, and the picked face holds the parts home', async ({ page }) => {
    const { assembly } = await openAssembly(page)
    await setApp(page, { modelMode: 'design', subPicks: [], pickFilter: ['face'] })
    await setApp(page, { selection: assembly, selectedIds: [assembly] })
    await page.getByTestId('explode-axis-z').click()
    await page.locator('#explode-spread').fill('100')
    await expect.poll(async () => (await exploded(page))[assembly]?.length ?? 0).toBe(3)
    const lift = (await exploded(page))[assembly]![2]![2]!
    expect(lift).toBeGreaterThan(20)
    await page.evaluate(() => (window as unknown as { __vp: { frameSelection(o: unknown): void } }).__vp.frameSelection({ animate: false }))
    await settledView(page)
    // the middle of the cap's top face, where it is drawn now
    // the middle of the cap's top face where it prints, from its real vertices and the object's transform (no turn here)
    const top = await page.evaluate((id) => {
      const e = (window as unknown as { __sx: { getState(): { plate: { id: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }[] } } }).__sx.getState().plate.find((p) => p.id === id)!
      const pos = e.parts[2]!.positions
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i + 2 < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, pos[i + k]!); hi[k] = Math.max(hi[k]!, pos[i + k]!) }
      const m = e.transform
      return [m[12]! + (lo[0]! + hi[0]!) / 2, m[13]! + (lo[1]! + hi[1]!) / 2, m[14]! + hi[2]!] as [number, number, number]
    }, assembly)
    const [sx, sy] = await page.evaluate((p) => (window as unknown as { __vp: Vp }).__vp.screenOf(p), [top[0], top[1], top[2] + lift])
    const under = await page.evaluate(([x, y]) => ({ el: document.elementFromPoint(x, y)?.tagName, hits: (window as unknown as { __vp: { pickAll(x: number, y: number): unknown[] } }).__vp.pickAll(x, y) }), [sx, sy] as const)
    await page.mouse.move(2, 2)
    await page.mouse.click(sx, sy)
    await expect.poll(async () => ((await appState(page)) as unknown as { subPicks: unknown[] }).subPicks.length, JSON.stringify({ sx, sy, under })).toBe(1)
    const pick = ((await appState(page)) as unknown as { subPicks: { kind: string; objectId: string; partIndex: number; point: number[] }[] }).subPicks[0]!
    expect(pick).toMatchObject({ kind: 'face', objectId: assembly, partIndex: 2 })
    // the point where the cap prints, not where it was drawn
    expect(Math.abs(pick.point[2]! - top[2])).toBeLessThan(0.5)
    // a picked face holds the parts home, with the bar waiting
    await expect(page.getByTestId('explode-hint')).toBeVisible()
    expect((await appState(page)).explode.spread).toBe(0)
    expect(await exploded(page)).toEqual({})
    await setApp(page, { subPicks: [], modelMode: 'slice' })
  })
})
