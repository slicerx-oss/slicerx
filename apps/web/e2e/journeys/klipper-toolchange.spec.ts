// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: a tool change on a Klipper tool changer (StealthChanger style) in Preview. A Klipper tool changer with two
// nozzles (a stored hand-added record with filamentSystem toolchanger in the first test, docks read over Moonraker in
// the second) slices two boxes in two filaments and plays the change: the head takes the
// tool to its dock on the front top frame, drops off it, and picks the other tool by the same path. Without the
// printer's own dock positions the dock is estimated from the nozzle count; positions the printer reported over
// Moonraker are used as measured. Review pictures with SX_SHOTS=1: at the unhook at 1440 x 900 and 390 x 844, dark and
// light, saved to SX_SHOTS_DIR (test-results/shots by default).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { boxOnPlate, calm, command, debugHooks, DESKTOP, patch, startSlice, state, toTop } from './lib/slice'
import { setState, shotsDir, shotsOn } from './lib/session'

const KLIPPER = { id: 'e2e-klipper', name: 'Shop Voron', profileId: 'generic-klipper', vendor: 'Other printer', model: 'Klipper printer', nozzleCount: 2, filamentSystem: 'toolchanger' }
const PHONE = { width: 390, height: 844 }
test.use({
  journeyPrefs: {
    workspace: 'prepare',
    settingsMode: 'advanced',
    pilot: { mode: 'off' },
    handPrinters: [KLIPPER],
    printerId: KLIPPER.id,
    printerNozzles: { [KLIPPER.id]: 0.4 },
    printerExtruders: { [KLIPPER.id]: [{ mm: 0.4 }, { mm: 0.4 }] },
  },
})
test.skip(({ isMobile }) => isMobile, 'Desktop project; the phone width is checked by resizing below')

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

interface Hook {
  timeline: { changes: { segment: number; start: number; duration: number; from: number; to: number }[] } | null
  seek(t: number): void
}
type Dock = { x: number; y: number; z: number; measured: boolean }
type V = { x: number; y: number; z: number; set(x: number, y: number, z: number): V; clone(): V; applyMatrix4(m: unknown): V; copy(v: V): V; sub(v: V): V; multiplyScalar(s: number): V; add(v: V): V }
type Obj = { name: string; visible: boolean; parent: Obj | null; position: V; traverse(f: (o: Obj) => void): void; getObjectByName(n: string): Obj | undefined }
type Win = {
  __pv: Hook
  __vp: {
    toolpaths: { changer: { kind: string; klipper?: { docks: Dock[]; safeY: number } } | null; root: Obj }
    camera: { position: V }
    controls: { target: V; update(): void }
    stage: { bedMatrix(): unknown }
    invalidate(): void
  }
  __sx: { getState(): { profile: { printerId: string } | null; plate: { id: string; handle: { parts: { name: string }[] } }[] }; setState(p: unknown): void }
}

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

/** Where the head is, what it shows and what the dock holds right now. */
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
    tp.root.getObjectByName('dock')?.traverse((o) => void (o.name === 'parked tool' && parked.push(o.visible)))
    return {
      kind: tp.changer?.kind ?? null,
      docks: tp.changer?.klipper?.docks ?? [],
      head: head ? { x: head.position.x, y: head.position.y, z: head.position.z } : null,
      carried: shown(head?.getObjectByName('klipper tool')),
      parked,
      names,
      chuteShown: shown(tp.root.getObjectByName('chute')),
    }
  })
}

/** A camera from the front, left and above, on the dock row at the front top of the frame. `far` backs it off for a phone. */
async function frameDocks(page: Page, far: number): Promise<void> {
  await page.evaluate((far) => {
    const w = window as unknown as Win
    const vp = w.__vp
    const docks = vp.toolpaths.changer?.klipper?.docks ?? []
    const cx = docks.reduce((a, d) => a + d.x, 0) / Math.max(1, docks.length)
    const m = vp.stage.bedMatrix()
    const dy = docks[0]?.y ?? -71
    const dz = docks[0]?.z ?? 270
    // On the dock row, a little under it where the head drops off the tool, from the front, left and above.
    const t = vp.controls.target.clone().set(cx, dy + 10, dz + 10).applyMatrix4(m)
    const c = vp.camera.position.clone().set(cx - 250 * far, dy + 10 - 300 * far, dz + 10 + 110 * far).applyMatrix4(m)
    vp.camera.position.copy(c)
    vp.controls.target.copy(t)
    vp.controls.update()
    vp.invalidate()
  }, far)
  await page.waitForTimeout(300)
}

async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size)
  if (size.width <= 900) await expect(page.locator('.sheet-tab[data-panel="slice-sidebar"]')).toBeAttached()
  else await expect(page.locator('aside.pane.sheet, aside.pane[inert]')).toHaveCount(0)
}

async function shots(page: Page, name: string, far: number): Promise<void> {
  if (!shotsOn()) return
  const dir = shotsDir(test.info())
  mkdirSync(dir, { recursive: true })
  const width = page.viewportSize()?.width ?? 0
  for (const scheme of ['dark', 'light'] as const) {
    await setState(page, { scheme, themeFollowsSystem: false })
    await page.mouse.move(0, 0)
    await frameDocks(page, far)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, `${name}-${width}-${scheme}.png`) })
  }
  await setState(page, { scheme: 'dark' })
}

/**
 * Seeks inside the change to the middle of the unhook: the head under the seated tool at its dock, the tool still in
 * place. A coarse pass finds the head at the dock between the seat and the pull back, a fine one the unhook itself.
 */
async function seekUnhook(page: Page, change: { start: number; duration: number }, dock: Dock): Promise<number> {
  const at = async (t: number) => {
    await page.evaluate((t) => (window as unknown as Win).__pv.seek(t), t)
    return (await scene(page)).head
  }
  const atDock = (h: { x: number; y: number; z: number } | null) => !!h && Math.abs(h.x - dock.x) < 0.5 && h.y > dock.y - 0.5 && h.y < dock.y + 16.5 && h.z > dock.z - 10.5 && h.z < dock.z + 0.5
  const unhook = (h: { x: number; y: number; z: number } | null) => !!h && Math.abs(h.x - dock.x) < 0.5 && Math.abs(h.y - dock.y) < 0.5 && h.z < dock.z - 3 && h.z > dock.z - 8
  for (let f = 0.02; f < 0.98; f += 0.004) {
    const t = change.start + change.duration * f
    if (!atDock(await at(t))) continue
    const step = change.duration * 0.004
    for (let u = t - step; u < t + 2 * step; u += 0.004) if (unhook(await at(u))) return (u - change.start) / change.duration
  }
  return -1
}

test('a Klipper tool changer parks the tool at its dock on the front top frame and picks the other, estimated on a stored hand-added record', async ({ page }) => {
  test.slow()
  await resize(page, DESKTOP)
  await calm(page, 'advanced', { keepPrinter: true })
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Win).__sx.getState().profile?.printerId)), { timeout: 60_000 }).toBe('generic-klipper')
  await twoBoxes(page)
  await patch(page, { showToolhead: true })
  await startSlice(page)
  await toTop(page)

  const change = await page.evaluate(() => {
    const changes = (window as unknown as Win).__pv.timeline?.changes ?? []
    return changes[Math.floor(changes.length / 2)] ?? null
  })
  expect(change, 'the two filaments make tool changes').not.toBeNull()
  const before = await scene(page)
  expect(before.kind).toBe('klipper-dock')
  expect(before.docks).toHaveLength(2)
  // No printer data: the dock is estimated, in front of the bed and over the printable height.
  expect(before.docks.every((d) => !d.measured && d.y < 0 && d.z > 250)).toBe(true)
  for (const part of ['cover', 'display', 'chip', 'motor', 'lever', 'beam']) expect(before.names).not.toContain(part)
  expect(before.names).toContain('shuttle')

  const from = change!.from === 0 ? 0 : 1
  const f = await seekUnhook(page, change!, before.docks[from]!)
  expect(f, 'the change reaches the unhook').toBeGreaterThan(0)
  const mid = await scene(page)
  // At the unhook the tool sits in its dock and the head drops away from it; the other tool waits in its own.
  expect(mid.parked).toEqual([true, true])
  expect(mid.carried).toBe(false)
  expect(mid.chuteShown).toBe(false)
  // After the change the tool it parked sits in its dock and the head carries the other one.
  await page.evaluate((t) => (window as unknown as Win).__pv.seek(t), change!.start + change!.duration * 0.97)
  const late = await scene(page)
  expect(late.parked[from]).toBe(true)
  expect(late.parked[1 - from]).toBe(false)
  expect(late.carried).toBe(true)

  const tUnhook = change!.start + change!.duration * f
  await page.evaluate((t) => (window as unknown as Win).__pv.seek(t), tUnhook)
  await shots(page, 'klipper-unhook', 1.4)
  await resize(page, PHONE)
  await page.evaluate((t) => (window as unknown as Win).__pv.seek(t), tUnhook)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await shots(page, 'klipper-unhook', 1.8)
  await resize(page, DESKTOP)
})

test('docks reported by the printer over Moonraker are used as measured', async ({ page }) => {
  test.slow()
  await resize(page, DESKTOP)
  await calm(page, 'advanced', { keepPrinter: true })
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Win).__sx.getState().profile?.printerId)), { timeout: 60_000 }).toBe('generic-klipper')
  // What setup keeps from a StealthChanger build's [tool] sections (the project's example park point for T0).
  const path = [{ y: 9.5, z: 4 }, { y: 9.5, z: 2 }, { y: 5.5, z: 0 }, { y: 0, z: 0, f: 0.5 }, { y: 0, z: -10 }, { y: 16, z: -10 }]
  await patch(page, { printerDocks: { [KLIPPER.id]: [{ tool: 0, parkMm: [48, -71, 290], safeYMm: 20, path }, { tool: 1, parkMm: [124, -71, 290], safeYMm: 20, path }] } })
  await twoBoxes(page)
  await patch(page, { showToolhead: true })
  await startSlice(page)
  await toTop(page)
  const s = await scene(page)
  expect(s.kind).toBe('klipper-dock')
  expect(s.docks).toEqual([{ x: 48, y: -71, z: 290, measured: true }, { x: 124, y: -71, z: 290, measured: true }])
  const change = await page.evaluate(() => (window as unknown as Win).__pv.timeline?.changes[0] ?? null)
  expect(change).not.toBeNull()
  expect(await seekUnhook(page, change!, s.docks[change!.from === 0 ? 0 : 1]!)).toBeGreaterThan(0)
  await patch(page, { printerDocks: {} })
})
