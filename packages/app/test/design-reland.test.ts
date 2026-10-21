// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part made in the tab stands on the bed with room for its skirt. A tab joined to it through the tab's geom.extrude
// pushes the skirt past the bed edge, so the part lands again the way a new part lands, and the step says how far it
// moved; a hole made another size through geom.hole then finds the hole where the part went. Runs against the geometry
// engine (live wasm when built, recorded replies otherwise).
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

describe('a step through the tools of the tab that pushes the skirt of a part off the bed', () => {
  it('lands the part again, says so, and the next step works on it where it went', { timeout: 60_000 }, async () => {
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
    // a tab out to 250 mm: the skirt would reach 260 mm on the 256 mm bed
    const tab = await run<{ landed?: string }>('geom.extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [240, 115] }, distance_mm: 5, operation: 'join' })
    const note = 'Clip did not fit on the bed where it stood, so it moved by (-97, 13) mm.'
    expect(tab.summary).toContain(note)
    expect(tab.output.landed).toBe(note)
    expect(printsOnBed(e(), get().bed)).toBe(true)
    const b = bounds(e().parts, e().transform)!
    expect([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]).toEqual([128, 128])
    // the hole moved with the part, from (215, 115) to (118, 128); a step that keeps the part on the bed moves nothing
    const r = await run<{ landed?: string; after: { center: number[]; diameterMm: number } }>('geom.hole', { design: d, center: [118, 128, 5], axis: [0, 0, -1], diameter_mm: 3.4, counterbore: { diameter_mm: 6.5, depth_mm: 3 } })
    expect(r.output.landed).toBeUndefined()
    r.output.after.center.forEach((v, k) => expect(v).toBeCloseTo([118, 128, 5][k]!, 3))
    expect(r.output.after.diameterMm).toBeCloseTo(3.4, 3)
  })
})
