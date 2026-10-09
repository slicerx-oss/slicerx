// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a big project keeps the page answering and builds each model once. A Bambu Studio P1S project with a mesh of
// a few hundred thousand triangles is opened on another printer, so the open switches printer, bed and settings. Nothing here is a wall time (a shared runner can be slow by any factor): the checks are relative or
// counts. The project's meshes are read in the project worker, so while that runs the page answers: its longest stall
// stays a small part of the read. And the 3D view builds each object once; the printer switch, the bed change and the
// settings that follow keep what was built.
import { expect, type Page } from '@playwright/test'
import { plateReady, test } from './fixtures'
import { zip } from './project-zip'

/** A closed tube of `rings` by `around` quads (2 triangles each), the size of a real scan's mesh. */
function tubeModel(rings: number, around: number): string {
  const v: string[] = []
  const t: string[] = []
  for (let r = 0; r <= rings; r++) {
    const z = (r / rings) * 40
    const rad = 15 + 3 * Math.sin(r / 7)
    for (let a = 0; a < around; a++) {
      const ang = (a / around) * Math.PI * 2
      v.push(`<vertex x="${(rad * Math.cos(ang)).toFixed(5)}" y="${(rad * Math.sin(ang)).toFixed(5)}" z="${z.toFixed(5)}"/>`)
    }
  }
  const at = (r: number, a: number) => r * around + (a % around)
  for (let r = 0; r < rings; r++) {
    for (let a = 0; a < around; a++) {
      t.push(`<triangle v1="${at(r, a)}" v2="${at(r, a + 1)}" v3="${at(r + 1, a + 1)}"/>`, `<triangle v1="${at(r, a)}" v2="${at(r + 1, a + 1)}" v3="${at(r + 1, a)}"/>`)
    }
  }
  // The ends, as fans around a center vertex each.
  const bottom = v.length
  v.push('<vertex x="0" y="0" z="0"/>', '<vertex x="0" y="0" z="40"/>')
  for (let a = 0; a < around; a++) t.push(`<triangle v1="${bottom}" v2="${at(0, a + 1)}" v3="${at(0, a)}"/>`, `<triangle v1="${bottom + 1}" v2="${at(rings, a)}" v3="${at(rings, a + 1)}"/>`)
  return `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="Tube" type="model"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object><object id="2" name="Ring" type="model"><mesh><vertices>${v.slice(0, around * 3).join('')}</vertices><triangles>${t.slice(0, around * 4).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 90 90 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 160 160 0"/></build></model>`
}

const P1S = {
  printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
  printer_model: 'Bambu Lab P1S',
  printer_variant: '0.4',
  nozzle_diameter: ['0.4'],
  layer_height: '0.28',
  sparse_infill_density: '5%',
  different_settings_to_system: ['layer_height;sparse_infill_density', '', ''],
}

const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

type Vp = { stats(): { objectBuilds: number } }
type Sx = { getState(): { plate: unknown[] } }

async function open(page: Page): Promise<void> {
  await page.addInitScript((a1) => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [a1], printerId: a1.id }))
  }, A1_MINI)
  await page.goto('./')
  await plateReady(page)
}

test('a big project opens with the page answering and each model built once', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  // About 300,000 triangles: a part a person opens every day, small enough for a shared runner.
  const file = zip({ '3D/3dmodel.model': tubeModel(375, 400), 'Metadata/project_settings.config': JSON.stringify(P1S) })
  // The page's stalls from here on: a timer that should fire every 10 ms, and each time it came more than 50 ms late.
  await page.evaluate(() => {
    const w = window as unknown as { __stalls: [number, number][] }
    w.__stalls = []
    let at = performance.now()
    const beat = () => {
      const now = performance.now()
      if (now - at > 50) w.__stalls.push([at, now])
      at = now
      setTimeout(beat, 10)
    }
    setTimeout(beat, 10)
  })
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await page.keyboard.press('ControlOrMeta+o')
    await (await chooser).setFiles({ name: 'tube.3mf', mimeType: 'model/3mf', buffer: file })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.obj-name')).toHaveText(['Tube', 'Ring'], { timeout: 120_000 })
  // On the person's own P1S when they have one, else as the project's printer.
  await expect(page.getByTestId('toast').filter({ hasText: /Opened (as|on) / })).toBeVisible({ timeout: 120_000 })
  // The open is over (the slice after it is not waited for: a shared runner's browser engine takes minutes on this mesh).
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('sx:open:done').length + performance.getEntriesByName('sx:open:drawn').length), { timeout: 120_000 }).toBe(2)
  const run = await page.evaluate(() => {
    const ms = Object.fromEntries(performance.getEntriesByType('measure').filter((e) => e.name.startsWith('sx:open:')).map((e) => [e.name.slice(8), e.startTime + e.duration]))
    const w = window as unknown as { __stalls: [number, number][]; __vp?: Vp; __sx?: Sx }
    return { ms, stalls: w.__stalls, builds: w.__vp?.stats().objectBuilds ?? -1, objects: w.__sx?.getState().plate.length ?? -1 }
  })
  // Every stage of the open was timed, in order.
  const stages = ['read', 'unzip', 'parse', 'printer', 'engine', 'objects', 'settings', 'done']
  for (const s of [...stages, 'drawn']) expect(run.ms[s], `stage ${s}`).toBeDefined()
  const ends = stages.map((s) => run.ms[s]!)
  expect(ends).toEqual([...ends].sort((a, b) => a - b))
  // The meshes are read in the worker: while that runs, the page's longest stall stays a small part of the read, as
  // it would not if they were read on the main thread.
  const [from, to] = [run.ms['read']!, run.ms['parse']!]
  const worst = Math.max(0, ...run.stalls.map(([a, b]) => Math.min(b, to) - Math.max(a, from)))
  expect(worst, `worst stall ${Math.round(worst)} ms while the meshes were read (${Math.round(to - from)} ms)`).toBeLessThan(Math.max((to - from) * 0.5, 200))
  // The view built the example plate's model, then each of the project's two objects once, however often the printer,
  // the bed and the settings changed after.
  expect(run.objects).toBe(2)
  expect(run.builds).toBeLessThanOrEqual(3)
  await page.waitForTimeout(1000)
  expect(await page.evaluate(() => (window as unknown as { __vp?: Vp }).__vp?.stats().objectBuilds ?? -1)).toBe(run.builds)
})
