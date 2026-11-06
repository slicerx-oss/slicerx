// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange in the engine: on a build that slices in the native engine (the desktop, and this test build), Arrange all
// sends the plate to the engine's arrange, the call `sx arrange --request` and the MCP server's slicerx_arrange_file
// make, and takes its layout. An A1 project printed by object, two parts taller than the gantry rod and two low ones,
// piled up with one in the nozzle wrap check corner: the plate check is sure of a strike as it stands; after Arrange
// every part is on the bed and out of the corner, nothing the check is sure of is left, and the plate slices with no
// collision and no collision warning.
import type { Page } from '@playwright/test'
import { expect, plateReady } from '../fixtures'
import { expectFileDialog, interceptFileDialogs } from '../file-dialog'
import { journey as test } from '../journey'
import { zip } from '../project-zip'

/** An A1 project printed by object: a box per part (`w` by `d`, `h` tall), its corner at `x`, `y`. */
function a1Project(parts: { name: string; w: number; d: number; h: number; x: number; y: number }[]): Buffer {
  const mesh = (w: number, d: number, h: number) => {
    const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]]
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
    return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${f.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
  }
  const ids = parts.map((_, i) => i + 1)
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${parts.map((p, i) => `<object id="${i + 1}" type="model">${mesh(p.w, p.d, p.h)}</object>`).join('')}</resources><build>${parts.map((p, i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${p.x} ${p.y} 0" printable="1"/>`).join('')}</build></model>`
  const objects = parts.map((p, i) => `<object id="${i + 1}"><metadata key="name" value="${p.name}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plate = `<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Parts"/><metadata key="locked" value="false"/>${ids.map((id) => `<model_instance><metadata key="object_id" value="${id}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`
  const settings = { printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], printable_area: ['0x0', '256x0', '256x256', '0x256'], layer_height: '0.2', print_sequence: 'by object', filament_colour: ['#00AE42'] }
  return zip({ '3D/3dmodel.model': model, 'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plate}</config>`, 'Metadata/project_settings.config': JSON.stringify(settings) })
}

const PARTS = [
  { name: 'Tower left', w: 20, d: 20, h: 40, x: 100, y: 100 },
  { name: 'Tower right', w: 20, d: 20, h: 40, x: 112, y: 104 },
  { name: 'Base plate', w: 40, d: 30, h: 6, x: 120, y: 96 },
  { name: 'Corner clip', w: 18, d: 18, h: 8, x: 232, y: 232 },
]

type Sx = {
  getState(): {
    plate: { id: string; name: string; transform: number[]; parts: { positions: Float32Array }[] }[]
    arranging: unknown
    toast: { text: string } | null
    plateCheck: { status: string; result: { certainty: string[]; collisions: { severity: string }[] } | null }
    slice: { status: string; stale?: boolean; result?: { collisions?: unknown[]; warnings: { code: string }[] } }
  }
}

/** Each part's footprint box on the bed. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __sx: Sx }).__sx.getState().plate.map((e) => {
      const t = e.transform
      const p = e.parts[0]!.positions
      let b = [Infinity, Infinity, -Infinity, -Infinity]
      for (let k = 0; k + 2 < p.length; k += 3) {
        const x = t[0]! * p[k]! + t[4]! * p[k + 1]! + t[12]!
        const y = t[1]! * p[k]! + t[5]! * p[k + 1]! + t[13]!
        b = [Math.min(b[0]!, x), Math.min(b[1]!, y), Math.max(b[2]!, x), Math.max(b[3]!, y)]
      }
      return { name: e.name, box: b }
    }),
  )

const sure = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plateCheck.result?.certainty.includes('sure') ?? null)

test.describe('Arrange in the engine', () => {
  test('lays an A1 plate printed by object out as the engine does, and it slices with no collision warning', async ({ page }) => {
    test.setTimeout(240_000)
    interceptFileDialogs(page)
    await page.addInitScript(() => {
      localStorage.setItem('slicerx.debug', '1')
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, autoSlice: false }))
    })
    // The layout comes from the engine: the page asks its arrange once, and the geometry worker nests nothing.
    const asked: string[] = []
    page.on('request', (r) => {
      if (/\/arranges\/\d+$/.test(new URL(r.url()).pathname)) asked.push(r.url())
    })
    await page.goto('./')
    await plateReady(page)
    const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
    await chooser.setFiles({ name: 'A1 parts.3mf', mimeType: 'model/3mf', buffer: a1Project(PARTS) })
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length), { timeout: 60_000 }).toBe(PARTS.length)
    // As the parts stand, the plate check is sure the toolhead meets a printed part.
    await expect.poll(() => sure(page), { timeout: 60_000 }).toBe(true)
    await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Arrange all' }).click()
    await expect.poll(() => asked.length, { timeout: 60_000 }).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().arranging), { timeout: 120_000 }).toBeNull()
    expect(asked).toHaveLength(1)
    // Every part fits: no arrange notice, every footprint on the bed and out of the wrap check corner (x 226 to 256, y 224 to 256).
    expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().toast?.text ?? '')).not.toMatch(/fit|larger than this bed|Arrange/)
    for (const { name, box } of await boxes(page)) {
      expect(box[0]!, name).toBeGreaterThanOrEqual(0)
      expect(box[1]!, name).toBeGreaterThanOrEqual(0)
      expect(box[2]!, name).toBeLessThanOrEqual(256)
      expect(box[3]!, name).toBeLessThanOrEqual(256)
      expect(box[2]! <= 226 || box[3]! <= 224, `${name} is out of the wrap check corner`).toBe(true)
    }
    // The plate check finds nothing it is sure of, and the warning goes.
    await expect.poll(() => sure(page), { timeout: 60_000 }).toBe(false)
    await expect(page.getByTestId('slice-clearance-warning').and(page.locator('[data-verdict="sure"]'))).toHaveCount(0)
    // It slices with no collision, and no collision warning shows.
    await page.getByRole('button', { name: /^Slice plate/ }).first().click()
    await expect.poll(() => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale }), { timeout: 150_000 }).toBe(true)
    const done = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.result!)
    expect(done.collisions ?? []).toEqual([])
    expect(done.warnings.map((w) => w.code).filter((c) => /collision|clearance|gantry|wrap/.test(c))).toEqual([])
    await expect(page.getByTestId('slice-clearance-warning')).toHaveCount(0)
  })
})
