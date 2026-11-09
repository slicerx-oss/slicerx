// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: a tool change on an IDEX printer (Snapmaker J1) in Preview. A person slices two boxes in two filaments and
// plays the change: the printing carriage runs to its own end of X and parks while the other comes in from its end,
// two heads on one rail, and the head never goes to the H2 family's purge chute. Review pictures with SX_SHOTS=1:
// mid change at 1440 x 900 and 390 x 844, dark and light, saved to SX_SHOTS_DIR (test-results/shots by default).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { boxOnPlate, calm, command, debugHooks, DESKTOP, patch, startSlice, state, toTop } from './lib/slice'
import { setState, shotsDir, shotsOn } from './lib/session'

const J1 = { id: 'e2e-j1', name: 'Desk J1', profileId: 'snapmaker-j1', vendor: 'Snapmaker', model: 'J1', nozzleCount: 2 }
const PHONE = { width: 390, height: 844 }
test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [J1], printerId: J1.id } })
test.skip(({ isMobile }) => isMobile, 'Desktop project; the phone width is checked by resizing below')

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

interface Hook {
  timeline: { changes: { segment: number; start: number; duration: number; from: number; to: number }[] } | null
  seek(t: number): void
}

type Obj = { name: string; visible: boolean; position: { x: number }; children: Obj[]; userData: Record<string, unknown>; traverse(f: (o: Obj) => void): void; getObjectByName(n: string): Obj | undefined }
type Win = {
  __pv: Hook
  __vp: { toolpaths: { changer: { kind: string; bed: { widthMm: number; depthMm: number }; idex?: { park: [number, number] } } | null; root: Obj } }
  __sx: { getState(): { profile: { printerId: string } | null; plate: { id: string; handle: { parts: { name: string }[] } }[] }; setState(p: unknown): void }
}

/** Two boxes, the second printed in filament 2 (the right carriage). */
async function twoBoxes(page: Page): Promise<void> {
  await boxOnPlate(page)
  await command(page, 'Add a box')
  await expect.poll(async () => (await state(page)).plate.length).toBe(2)
  if ((await page.locator('[data-testid="slice-filament-slot"][data-slot="2"]').count()) === 0) {
    await page.getByTestId('slice-filament-add').first().click()
    // A new filament opens its dialog; its defaults do.
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

/** What the toolhead and the purge rig show right now. */
function scene(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as Win
    const tp = w.__vp.toolpaths
    const names: string[] = []
    const head = tp.root.getObjectByName('toolhead')
    head?.traverse((o) => names.push(o.name))
    const carriages: number[] = []
    head?.getObjectByName('nozzle')?.children.forEach((c) => void (c.name === 'idex carriage' && carriages.push(c.position.x)))
    const chute = tp.root.getObjectByName('chute')
    let chuteShown = !!chute?.visible
    for (let p = chute as unknown as { visible: boolean; parent: unknown } | undefined; p && chuteShown; p = p.parent as typeof p) if (!p.visible) chuteShown = false
    return { kind: tp.changer?.kind ?? null, park: tp.changer?.idex?.park ?? null, names, carriages, chuteShown }
  })
}

async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size)
  if (size.width <= 900) await expect(page.locator('.sheet-tab[data-panel="slice-sidebar"]')).toBeAttached()
  else await expect(page.locator('aside.pane.sheet, aside.pane[inert]')).toHaveCount(0)
}

async function shots(page: Page, name: string): Promise<void> {
  if (!shotsOn()) return
  const dir = shotsDir(test.info())
  mkdirSync(dir, { recursive: true })
  const width = page.viewportSize()?.width ?? 0
  for (const scheme of ['dark', 'light'] as const) {
    await setState(page, { scheme, themeFollowsSystem: false })
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, `${name}-${width}-${scheme}.png`) })
  }
  await setState(page, { scheme: 'dark' })
}

test('an IDEX tool change parks the printing carriage at its end of X while the other comes in, with no purge chute', async ({ page }) => {
  test.slow()
  await resize(page, DESKTOP)
  await calm(page, 'advanced', { keepPrinter: true })
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Win).__sx.getState().profile?.printerId)), { timeout: 60_000 }).toBe('snapmaker-j1')
  await twoBoxes(page)
  await patch(page, { showToolhead: true })
  await startSlice(page)
  await toTop(page)

  // A change halfway up the boxes, so the printed part shows under the carriages.
  const first = await page.evaluate(() => {
    const changes = (window as unknown as Win).__pv.timeline?.changes ?? []
    return changes[Math.floor(changes.length / 2)] ?? null
  })
  expect(first, 'the two filaments make tool changes').not.toBeNull()
  // Inside the change: both carriages on their way, the left one toward its end, the right one in from its end.
  const at = (f: number) => page.evaluate((t) => (window as unknown as Win).__pv.seek(t), first!.start + first!.duration * f)
  await at(0.45)
  await expect.poll(async () => (await scene(page)).carriages.length).toBe(2)
  const mid = await scene(page)
  expect(mid.kind).toBe('idex-park')
  // Two heads on one rail; none of the H2 head's parts, and the purge chute stays hidden.
  expect(mid.names).toContain('idex rail')
  for (const h2 of ['cover', 'display', 'chip']) expect(mid.names).not.toContain(h2)
  expect(mid.chuteShown).toBe(false)
  const [left, right] = mid.carriages as [number, number]
  const [park0, park1] = mid.park!
  expect(left).toBeGreaterThanOrEqual(park0 - 0.01)
  expect(right).toBeLessThanOrEqual(park1 + 0.01)
  expect(right - left).toBeGreaterThan(40)
  // Through the whole change no frame shows the chute, and the left carriage always stays left of the right one.
  for (const f of [0, 0.1, 0.25, 0.6, 0.8, 0.95, 1]) {
    await at(f)
    const s = await scene(page)
    expect(s.chuteShown, `at ${f}`).toBe(false)
    expect(s.carriages[1]! - s.carriages[0]!, `at ${f}`).toBeGreaterThan(40)
  }

  await at(0.45)
  await shots(page, 'j1-midswap')
  await resize(page, PHONE)
  await at(0.45)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  // The phone's view fits the bed; one wheel step out brings the parked carriage's end of the rail into the picture too.
  const box = await page.locator('canvas').first().boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 300)
  }
  await shots(page, 'j1-midswap')
  await resize(page, DESKTOP)
})
