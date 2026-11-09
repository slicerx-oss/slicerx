// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: a tool change on the Prusa Core One with INDX in Preview. A person slices two boxes in two filaments and plays
// the change: the Smart Head backs its tool into its dock at the front and releases it, runs along the dock row to the
// next tool, latches it and pulls it out, heats it, blobs and wipes at the purge collector and returns. Never the
// Bambu head or chute, the U1 rack or the Klipper dock. Review pictures with SX_SHOTS=1: the new tool half out of its
// dock, at 1440 x 900 and 390 x 844, dark and light, saved to SX_SHOTS_DIR (test-results/shots by default).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { boxOnPlate, calm, command, debugHooks, DESKTOP, patch, startSlice, state, toTop } from './lib/slice'
import { setState, shotsDir, shotsOn } from './lib/session'

const INDX = { id: 'e2e-indx', name: 'Shop Core One', profileId: 'prusa-core-one-indx', vendor: 'Prusa Research', model: 'Core One INDX', nozzleCount: 8 }
const PHONE = { width: 390, height: 844 }
test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [INDX], printerId: INDX.id } })
test.skip(({ isMobile }) => isMobile, 'Desktop project; the phone width is checked by resizing below')

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

interface Hook {
  timeline: { changes: { segment: number; start: number; duration: number; from: number; to: number }[] } | null
  seek(t: number): void
}
type FrontDock = { x: number[]; dockY: number; clearY: number; purge: { x: number; y: number } }
type V = { set(x: number, y: number, z: number): V; clone(): V; applyMatrix4(m: unknown): V; copy(v: V): V }
type Obj = { name: string; visible: boolean; parent: Obj | null; userData: Record<string, unknown>; position: { x: number; y: number; z: number }; children: Obj[]; traverse(f: (o: Obj) => void): void; getObjectByName(n: string): Obj | undefined }
type Win = {
  __pv: Hook
  __vp: {
    toolpaths: { changer: { kind: string; frontDock?: FrontDock } | null; root: Obj }
    camera: { position: V }
    controls: { target: V; update(): void }
    stage: { bedMatrix(): unknown }
    invalidate(): void
  }
  __sx: { getState(): { profile: { printerId: string } | null; plate: { id: string; handle: { parts: { name: string }[] } }[] }; setState(p: unknown): void }
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

/** Where the head is, whether it carries a tool, which docks hold one, and which parts are drawn. */
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
    tp.root.getObjectByName('dock')?.traverse((o) => void (o.name === 'tool' && parked.push(o.visible)))
    const carried = head?.children.find((c) => c.name === 'tool')
    return {
      kind: tp.changer?.kind ?? null,
      dock: tp.changer?.frontDock ?? null,
      head: head ? { x: head.position.x, y: head.position.y, z: head.position.z } : null,
      carried: shown(carried),
      parked,
      names,
      chuteShown: shown(tp.root.getObjectByName('chute')),
    }
  })
}

/** A camera from the front, left and above, on the docks of the change's two tools. `far` backs it off for a phone. */
async function frameDocks(page: Page, xs: [number, number], far: number): Promise<void> {
  await page.evaluate(
    ({ xs, far }) => {
      const w = window as unknown as Win
      const vp = w.__vp
      const k = vp.toolpaths.changer?.frontDock
      const head = vp.toolpaths.root.getObjectByName('nozzle')
      const cx = (xs[0] + xs[1]) / 2
      const y = k?.dockY ?? -26
      const z = head?.position.z ?? 10
      const m = vp.stage.bedMatrix()
      const t = vp.controls.target.clone().set(cx, y + 10, z + 30).applyMatrix4(m)
      const c = vp.camera.position.clone().set(cx - 140 * far, y - 240 * far, z + 150 * far).applyMatrix4(m)
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

test('a Core One INDX change parks the tool in its front dock, picks the next one, purges and returns', async ({ page }) => {
  test.slow()
  await resize(page, DESKTOP)
  await calm(page, 'advanced', { keepPrinter: true })
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Win).__sx.getState().profile?.printerId)), { timeout: 60_000 }).toBe('prusa-core-one-indx')
  await twoBoxes(page)
  await patch(page, { showToolhead: true })
  await startSlice(page)
  await toTop(page)

  const change = await page.evaluate(() => {
    const changes = (window as unknown as Win).__pv.timeline?.changes ?? []
    return changes[Math.floor(changes.length / 2)] ?? null
  })
  expect(change, 'the two filaments make tool changes').not.toBeNull()
  // About the profile's 12 s per change.
  expect(change!.duration).toBeGreaterThan(11)
  expect(change!.duration).toBeLessThan(16)
  const before = await scene(page)
  expect(before.kind).toBe('front-dock')
  const k = before.dock!
  expect(k.x).toHaveLength(8)
  for (const own of ['smart head', 'coupling plate', 'frame bar', 'purge collector', 'wiper']) expect(before.names).toContain(own)
  for (const other of ['cover', 'display', 'chip', 'motor', 'lever', 'beam', 'shuttle', 'parked tool']) expect(before.names).not.toContain(other)

  // Step through the change: the head goes into the old tool's dock, then the new tool's, then to the purge collector.
  const order: string[] = []
  let half = -1
  for (let f = 0; f <= 1; f += 0.005) {
    const t = change!.start + change!.duration * f
    await seek(page, t)
    const s = await scene(page)
    expect(s.chuteShown, `at ${f}`).toBe(false)
    const h = s.head!
    // Never further forward than a seated tool.
    expect(h.y, `at ${f}`).toBeGreaterThanOrEqual(k.dockY - 0.01)
    const where = h.y < k.clearY - 0.5 ? (Math.abs(h.x - k.x[change!.from]!) < 0.5 ? 'old dock' : Math.abs(h.x - k.x[change!.to]!) < 0.5 ? 'new dock' : 'other dock') : Math.hypot(h.x - k.purge.x, h.y - k.purge.y) < 30 ? 'purge' : ''
    if (where && order[order.length - 1] !== where) order.push(where)
    // The new tool on its way out of its dock, about half way: the review frame.
    if (where === 'new dock' && s.carried && half < 0 && Math.abs(h.y - (k.dockY + k.clearY) / 2) < 3) half = f
  }
  expect(order).toEqual(['old dock', 'new dock', 'purge'])
  expect(half, 'the new tool comes half out of its dock').toBeGreaterThan(0)

  const tHalf = change!.start + change!.duration * half
  await seek(page, tHalf)
  const mid = await scene(page)
  expect(mid.carried).toBe(true)
  // The tool it parked stands in its dock; the new one is in the head; spares fill the docks the print does not use.
  expect(mid.parked[change!.from]).toBe(true)
  expect(mid.parked[change!.to]).toBe(false)
  expect(mid.parked.filter((p) => p)).toHaveLength(7)

  const xs: [number, number] = [k.x[change!.from]!, k.x[change!.to]!]
  await shots(page, 'indx-half-out', xs, 1)
  await resize(page, PHONE)
  await seek(page, tHalf)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await shots(page, 'indx-half-out', xs, 1.6)
  await resize(page, DESKTOP)
})
