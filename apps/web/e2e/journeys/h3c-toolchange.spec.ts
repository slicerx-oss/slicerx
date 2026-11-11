// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: a tool change on the Bambu Lab H3C in Preview. A person slices two boxes in two filaments and plays the
// change: the SwapTek rack at the front lowers, the head backs its PrintTool into its dock and unlocks it, runs along
// the docks to the PrintTool of the next filament's hotend, locks it and pulls it out, then goes to the chute at the
// back right and leaves by the change G-code's exit moves, and the rack rises again. Preview plays as many changes as
// the slice makes, each on the hotend of the slice's filament map. Never the H2C rack, the INDX docks or the U1 dock.
// Review pictures with SX_SHOTS=1: the new PrintTool half out of its dock, at 1440 x 900 and 390 x 844, dark and light,
// saved to SX_SHOTS_DIR (test-results/shots by default).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { boxOnPlate, calm, command, debugHooks, DESKTOP, patch, startSlice, state, toTop } from './lib/slice'
import { setState, shotsDir, shotsOn } from './lib/session'

const H3C = { id: 'e2e-h3c-play', name: 'Desk H3C', profileId: 'bambu-h3c', vendor: 'Bambu Lab', model: 'H3C', nozzleCount: 9 }
const PHONE = { width: 390, height: 844 }
test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [H3C], printerId: H3C.id } })
test.skip(({ isMobile }) => isMobile, 'Desktop project; the phone width is checked by resizing below')

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

interface Hook {
  timeline: { changes: { segment: number; start: number; duration: number; from: number; to: number }[] } | null
  seek(t: number): void
}
type PrintTool = { x: number[]; dockY: number; clearY: number; rise: number }
type V = { set(x: number, y: number, z: number): V; clone(): V; applyMatrix4(m: unknown): V; copy(v: V): V }
type Obj = { name: string; visible: boolean; parent: Obj | null; userData: Record<string, unknown>; position: { x: number; y: number; z: number }; children: Obj[]; traverse(f: (o: Obj) => void): void; getObjectByName(n: string): Obj | undefined }
type Win = {
  __pv: Hook
  __vp: {
    toolpaths: { changer: { kind: string; extruderOf: number[]; printTool?: PrintTool; chute?: { x: number; y: number } } | null; root: Obj }
    camera: { position: V }
    controls: { target: V; update(): void }
    stage: { bedMatrix(): unknown }
    invalidate(): void
  }
  __sx: {
    getState(): {
      profile: { printerId: string } | null
      plate: { id: string; handle: { parts: { name: string }[] } }[]
      slice: { status: string; result?: { stats?: { toolChanges: number }; filamentMap?: { nozzles: number[] } } }
    }
    setState(p: unknown): void
  }
}

/** Two boxes, the second printed in filament 2 (tool T1). */
async function twoBoxes(page: Page): Promise<void> {
  await boxOnPlate(page)
  await command(page, 'Add a box')
  await expect.poll(async () => (await state(page)).plate.length).toBe(2)
  if ((await page.locator('[data-testid="slice-filament-slot"][data-slot="2"]').count()) === 0) {
    await page.getByTestId('slice-filament-add').first().click()
    const dialog = page.getByRole('dialog', { name: /Filament 2/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
  await page.evaluate(() => {
    const w = window as unknown as Win
    const [a, b] = w.__sx.getState().plate
    w.__sx.setState({ plate: [a, { ...b, slotOverrides: Object.fromEntries(b!.handle.parts.map((p) => [p.name, 2])) }] })
  })
}

/** Where the head is, whether it carries a PrintTool, which docks hold one, where the rack stands and which parts are drawn. */
function scene(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as Win
    const tp = w.__vp.toolpaths
    const shown = (o: Obj | undefined) => {
      for (let p: Obj | null | undefined = o; p; p = p.parent) if (!p.visible) return false
      return !!o
    }
    const head = tp.root.getObjectByName('nozzle')
    const names: string[] = []
    tp.root.getObjectByName('toolhead')?.traverse((o) => names.push(o.name))
    const parked: boolean[] = []
    const rack = tp.root.getObjectByName('dock')
    rack?.traverse((o) => void (o.name === 'tool' && parked.push(o.visible)))
    const carried = head?.children.find((c) => c.name === 'tool')
    // The light edges shown: on the PrintTool in the head (-1) and on the dock in play.
    const edges: number[] = []
    if (carried?.getObjectByName('edge')?.visible) edges.push(-1)
    rack?.traverse((o) => void (o.name === 'tool' && o.visible && o.getObjectByName('edge')?.visible && edges.push(Number(o.userData.slot))))
    return {
      edges,
      kind: tp.changer?.kind ?? null,
      extruderOf: tp.changer?.extruderOf ?? [],
      rack: tp.changer?.printTool ?? null,
      chute: tp.changer?.chute ?? null,
      head: head ? { x: head.position.x, y: head.position.y, z: head.position.z } : null,
      rackZ: rack?.position.z ?? null,
      carried: shown(carried),
      parked,
      names,
      chuteShown: shown(tp.root.getObjectByName('chute')),
    }
  })
}

/** A camera on the docks of the change's two PrintTools. `far` backs it off for a phone. */
async function frameDocks(page: Page, xs: [number, number], far: number): Promise<void> {
  await page.evaluate(
    ({ xs, far }) => {
      const w = window as unknown as Win
      const vp = w.__vp
      const k = vp.toolpaths.changer?.printTool
      const head = vp.toolpaths.root.getObjectByName('nozzle')
      const cx = (xs[0] + xs[1]) / 2
      const y = k?.dockY ?? -40
      const z = head?.position.z ?? 10
      const m = vp.stage.bedMatrix()
      // From the bed side, left and a little above: the rack row behind the head, and the PrintTool under the head.
      const t = vp.controls.target.clone().set(cx + 10, y + 4, z + 18).applyMatrix4(m)
      const c = vp.camera.position.clone().set(cx - 150 * far, y + 230 * far, z + 70 * far).applyMatrix4(m)
      vp.camera.position.copy(c)
      vp.controls.target.copy(t)
      vp.controls.update()
      vp.invalidate()
    },
    { xs, far },
  )
  await page.waitForTimeout(300)
}

async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size)
  if (size.width <= 900) await expect(page.locator('.sheet-tab[data-panel="slice-sidebar"]')).toBeAttached()
  else await expect(page.locator('aside.pane.sheet, aside.pane[inert]')).toHaveCount(0)
}

async function shots(page: Page, name: string, xs: [number, number], far: number): Promise<void> {
  if (!shotsOn()) return
  const dir = shotsDir(test.info())
  mkdirSync(dir, { recursive: true })
  const width = page.viewportSize()?.width ?? 0
  for (const scheme of ['dark', 'light'] as const) {
    await setState(page, { scheme, themeFollowsSystem: false })
    await page.mouse.move(0, 0)
    await frameDocks(page, xs, far)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, `${name}-${width}-${scheme}.png`) })
  }
  await setState(page, { scheme: 'dark' })
}

const seek = (page: Page, t: number) => page.evaluate((t) => (window as unknown as Win).__pv.seek(t), t)

test('an H3C change parks the PrintTool on the front rack, picks the next hotend, leaves the chute and plays every change of the slice', async ({ page }) => {
  test.slow()
  await resize(page, DESKTOP)
  await calm(page, 'advanced', { keepPrinter: true })
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Win).__sx.getState().profile?.printerId)), { timeout: 60_000 }).toBe('bambu-h3c')
  // Two filaments of clearly different colors, so the PrintTool in play reads against the black head and the steel rack.
  const pla = { type: 'PLA', brand: '' }
  await setState(page, { slotSetup: { 1: { ...pla, color: '#f28c28' }, 2: { ...pla, color: '#2ab7ca' } } })
  await twoBoxes(page)
  await patch(page, { showToolhead: true })
  await startSlice(page)
  await toTop(page)

  // As many changes as the slice makes, each to the hotend of the slice's filament map.
  const slice = await page.evaluate(() => (window as unknown as Win).__sx.getState().slice.result)
  const changes = await page.evaluate(() => (window as unknown as Win).__pv.timeline?.changes ?? [])
  expect(changes.length, 'the two filaments make tool changes').toBeGreaterThan(0)
  expect(changes).toHaveLength(slice?.stats?.toolChanges ?? -1)
  const before = await scene(page)
  expect(before.kind).toBe('printtool-rack')
  const hotends = slice?.filamentMap?.nozzles ?? []
  expect(before.extruderOf).toEqual([hotends[0] ?? 0, hotends[1] ?? 0])
  expect(hotends[0]).not.toBe(hotends[1])
  const k = before.rack!
  expect(k.x).toHaveLength(9)
  for (const own of ['h3c head', 'lock plate', 'cover', 'rack beam', 'hanger']) expect(before.names).toContain(own)
  for (const other of ['smart head', 'coupling plate', 'frame bar', 'holder', 'bay front', 'motor', 'lever', 'shuttle']) expect(before.names).not.toContain(other)
  // Away from a change the rack waits raised.
  expect(before.rackZ).toBeCloseTo(k.rise, 3)
  expect(before.chuteShown).toBe(true)

  const change = changes[Math.floor(changes.length / 2)]!
  const dock = (t: number) => k.x[before.extruderOf[t] ?? 0]!
  // Step through the change: the head goes into the old PrintTool's dock, then the new one's, then to the chute.
  const order: string[] = []
  let half = -1
  let lowered = false
  let parkedLit = false
  for (let f = 0; f <= 1; f += 0.005) {
    const t = change.start + change.duration * f
    await seek(page, t)
    const s = await scene(page)
    const h = s.head!
    // Never further forward than a seated PrintTool.
    expect(h.y, `at ${f}`).toBeGreaterThanOrEqual(k.dockY - 0.01)
    const where = h.y < k.clearY - 0.5 ? (Math.abs(h.x - dock(change.from)) < 0.5 ? 'old dock' : Math.abs(h.x - dock(change.to)) < 0.5 ? 'new dock' : 'other dock') : Math.hypot(h.x - s.chute!.x, h.y - s.chute!.y) < 30 ? 'chute' : ''
    if (where && order[order.length - 1] !== where) order.push(where)
    // At a dock the rack is down at the head's height.
    if (where.endsWith('dock')) {
      expect(s.rackZ, `at ${f}`).toBeCloseTo(0, 3)
      lowered = true
    }
    // Just parked, the PrintTool in the old dock keeps the light edge while the head is still in front of it.
    if (where === 'old dock' && !s.carried) {
      expect(s.edges, `at ${f}`).toEqual([before.extruderOf[change.from]])
      parkedLit = true
    }
    // The new PrintTool on its way out of its dock, about half way: the review frame.
    if (where === 'new dock' && s.carried && half < 0 && Math.abs(h.y - (k.dockY + k.clearY) / 2) < 3) half = f
  }
  expect(order).toEqual(['old dock', 'new dock', 'chute'])
  expect(lowered).toBe(true)
  expect(parkedLit, 'the parked PrintTool shows while the head is at its dock').toBe(true)
  expect(half, 'the new PrintTool comes half out of its dock').toBeGreaterThan(0)

  const tHalf = change.start + change.duration * half
  await seek(page, tHalf)
  const mid = await scene(page)
  expect(mid.carried).toBe(true)
  // The PrintTool it parked hangs in its dock; the new one is in the head; spares fill the docks the print does not use.
  expect(mid.parked[before.extruderOf[change.from]!]).toBe(true)
  expect(mid.parked[before.extruderOf[change.to]!]).toBe(false)
  expect(mid.parked.filter((p) => p)).toHaveLength(8)
  // The PrintTool in the head carries the light edge; parked ones stay plain.
  expect(mid.edges).toEqual([-1])
  // Away from a change only the PrintTool in the head has it.
  expect(before.edges).toEqual([-1])

  const xs: [number, number] = [dock(change.from), dock(change.to)]
  await shots(page, 'h3c-half-out', xs, 1.7)
  await resize(page, PHONE)
  await seek(page, tHalf)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await shots(page, 'h3c-half-out', xs, 2.6)
  await resize(page, DESKTOP)
})
