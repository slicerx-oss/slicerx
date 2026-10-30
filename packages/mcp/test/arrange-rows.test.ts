// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Copies of a box fill as many rows as their boxes hold. 10 x 50 mm bars on a 100 x 60 mm bed 2 mm apart: eight
// stand side by side, 8 x 10 + 7 x 2 = 94 mm of the 96 inside the edge gap, as slicerx_arrange counts them. The nest
// placed seven, so the arrange refused the eighth.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { boxStl, connect, data, noSxGeom, sxGeomBin } from './helpers'

type Placement = { objectId: string; centerMm: [number, number]; sizeMm: [number, number, number] }
type Shown = { plates: { index: number; placements: Placement[] }[] }

it.skipIf(noSxGeom())('arrange puts as many bars on a plate as rows of them hold', { timeout: 120_000 }, async () => {
  const h = await connect({ sxGeomBin })
  try {
    const call = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => {
      const r = await h.call(name, args)
      const d = data<{ ok?: boolean; summary: string; output: T }>(r)
      expect(r.isError, `${name}: ${d.summary}`).not.toBe(true)
      expect(d.ok, `${name}: ${d.summary}`).not.toBe(false)
      return d
    }
    await call('slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
    await call('slicerx_project_set_overrides', { changes: { printable_area: ['0x0', '100x0', '100x60', '0x60'], bed_exclude_area: [], brim_type: 'no_brim', skirt_loops: 0, enable_support: false } })
    writeFileSync(join(h.dir, 'bar.stl'), boxStl(10, 50, 5))
    await call('slicerx_project_add_model', { model: join(h.dir, 'bar.stl') })
    const r = await call<{ plates: { plate: number; copies: number }[] }>('slicerx_arrange', { objectId: 'obj-1', count: 8, plates: 1, spacing: 2 })
    expect(r.output.plates).toEqual([expect.objectContaining({ plate: 1, copies: 8 })])
    const s = (await call<{ project: Shown }>('slicerx_project_show')).output as unknown as Shown
    const bars = s.plates[0]!.placements.map((p) => ({ x0: p.centerMm[0] - p.sizeMm[0] / 2, x1: p.centerMm[0] + p.sizeMm[0] / 2, y0: p.centerMm[1] - p.sizeMm[1] / 2, y1: p.centerMm[1] + p.sizeMm[1] / 2 }))
    expect(bars).toHaveLength(8)
    for (const b of bars) expect([b.x0, b.y0, 100 - b.x1, 60 - b.y1].every((d) => d >= 2 - 1e-2), JSON.stringify(b)).toBe(true)
    for (let i = 0; i < bars.length; i++) {
      for (let j = i + 1; j < bars.length; j++) {
        const [a, b] = [bars[i]!, bars[j]!]
        expect(Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1)).toBeGreaterThanOrEqual(2 - 1e-2)
      }
    }
  } finally {
    await h.client.close()
  }
})
