// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part made in the tab stands on the bed, then its skirt grows (a wider skirt picked for the plate) so that it reaches
// past the bed edge. The next step, a hole made another size through the tab's geom.hole, lands it again the way a new
// part lands, says how far it moved, and reads the hole back where it went. Runs against the geometry engine (live
// wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { designToolset } from '@slicerx/mcp/toolset'
import { afterEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { NO_MARGINS, printsOnBed, setMarginSource, type PrintMargins } from '../src/plate/arrange'
import { bounds } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('design-reland-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const skirt = (reach: number): PrintMargins => ({ grow: () => 0, reach: () => reach, skirt: true, keepOut: [] })

afterEach(() => setMarginSource(() => NO_MARGINS))

describe('a hole edit on a part whose skirt now reaches off the bed', () => {
  it('lands the part again, says so, and reads the hole back where it moved', { timeout: 60_000 }, async () => {
    set({ plate: [], selection: null, selectedIds: [], historyEdit: null, bed: { widthMm: 256, depthMm: 256, heightMm: 256 } })
    setMarginSource(() => skirt(10))
    const tools = new Map(designToolset(appDesignHost(loader), {}, {}).map((t) => [t.name, t]))
    const run = async <T,>(name: string, input: Record<string, unknown>): Promise<{ summary: string; output: T }> => {
      const tool = tools.get(name)!
      const out = await tool.run(tool.input.parse(input) as never, {} as never)
      expect(out.ok, `${name}: ${out.summary}`).not.toBe(false)
      return out as { summary: string; output: T }
    }
    const d = (await run<{ design: string }>('design.new', { name: 'Clip' })).output.design
    // 30 by 20 mm at (215, 115): 26 mm from the right edge, so a 10 mm skirt fits and nothing moves
    const made = await run<{ landed?: string }>('geom.extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [215, 115] }, distance_mm: 5 })
    expect(made.output.landed).toBeUndefined()
    await run('geom.extrude', { design: d, shape: { type: 'circle', diameterMm: 6 }, frame: { origin: [0, 0, 5], normal: [0, 0, 1] }, placement: { center: [215, 115] }, distance_mm: 5, operation: 'cut' })
    const e = () => get().plate.find((p) => p.id === d)!
    expect(printsOnBed(e(), get().bed)).toBe(true)
    // a 30 mm skirt now: it reaches 260 mm on the 256 mm bed
    setMarginSource(() => skirt(30))
    expect(printsOnBed(e(), get().bed)).toBe(false)
    const r = await run<{ landed?: string; before: { center: number[] }; after: { center: number[]; diameterMm: number } }>('geom.hole', { design: d, center: [215, 115, 5], axis: [0, 0, -1], diameter_mm: 3.4, counterbore: { diameter_mm: 6.5, depth_mm: 3 } })
    expect(printsOnBed(e(), get().bed)).toBe(true)
    const b = bounds(e().parts, e().transform)!
    expect([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]).toEqual([128, 128])
    expect(r.summary).toContain('Clip did not fit on the bed where it stood, so it moved by (-87, 13) mm.')
    expect(r.output.landed).toBe('Clip did not fit on the bed where it stood, so it moved by (-87, 13) mm.')
    expect(r.output.before.center).toEqual([215, 115, 5])
    r.output.after.center.forEach((v, k) => expect(v).toBeCloseTo([128, 128, 5][k]!, 3))
    expect(r.output.after.diameterMm).toBeCloseTo(3.4, 3)
  })
})
