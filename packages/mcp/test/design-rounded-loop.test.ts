// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client rounds the top loop of a rounded box in a design, the way an agent would: one edge pick, then the loop it
// returns (the straight sides and every side of the corner rounds) in one fillet step, which replays when its radius
// changes.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface EdgeRef {
  a: V3
  b: V3
  face: V3
}
interface Summary {
  design: string
  sizeMm: V3
  volumeMm3: number
  parts: unknown[]
}
interface Row {
  op: string
  state: string
}

const geom = useGeomEngine('design-rounded-loop')
// the corner's cross section a 1 mm round takes along the top loop's outline, mm2
const ROUND = 1 - Math.PI / 4
// the top loop of a 30 by 20 box with 3 mm corners, mm
const OUTLINE = 2 * (30 + 20) - 8 * 3 + 2 * Math.PI * 3

describe('a client rounds a rounded box', () => {
  it('rounds the whole top loop in one step, corners included, and keeps it when the radius changes', async () => {
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary & { steps: Row[] }> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary & { steps: Row[] } }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Rounded box' })).design
    const box = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20, cornerRadiusMm: 3 }, distance_mm: 6, name: 'Box' })
    expect(box.sizeMm).toEqual([30, 20, 6])

    const e = await h.call('slicerx_geom_edge_pick', { design: d, face: { at: [0, -9.9, 6], normal: [0, 0, 1] }, list_edges: true })
    expect(e.isError, text(e)).toBeFalsy()
    const pick = data<{ output: { edge: EdgeRef; supported: boolean; lengthMm: number; maxRadiusMm: number; loop: { edge: EdgeRef; supported: boolean }[] } }>(e).output
    expect(pick.supported).toBe(true)
    expect(pick.lengthMm).toBeCloseTo(24, 3)
    // the straight edge alone: as tall as the wall; the corners' own sides hold a round to 3 mm
    expect(pick.maxRadiusMm).toBeCloseTo(6, 3)
    expect(pick.loop.length).toBeGreaterThan(4)
    expect(pick.loop.every((l) => l.supported)).toBe(true)
    const loop = pick.loop.map((l) => l.edge)

    // a round wider than the corners is refused in words and leaves the design as it was
    const tight = await h.call('slicerx_geom_fillet', { design: d, edges: loop, radius_mm: 3.5, all_or_nothing: true })
    expect(tight.isError).toBe(true)
    expect(text(tight)).toMatch(/does not fit.*design is unchanged/s)

    const rounded = await ok('slicerx_geom_fillet', { design: d, edges: loop, radius_mm: 1, tolerance_mm: 0.01 })
    expect(rounded.parts).toHaveLength(1)
    const lost = box.volumeMm3 - rounded.volumeMm3
    expect(lost).toBeGreaterThan(ROUND * (OUTLINE - 2))
    expect(lost).toBeLessThan(ROUND * OUTLINE * 1.06)
    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => [s.op, s.state])).toEqual([
      ['shape.extrude', 'done'],
      ['edge.fillet', 'done'],
    ])

    // a smaller round: the step runs again, finding each edge along the rounds by its faces' keys and its place
    const smaller = await h.call('slicerx_design_edit_step', { design: d, step: 2, value: 0.5 })
    const edited = data<{ ok: boolean; output: Summary & { steps: Row[] } }>(smaller)
    expect(edited.ok, text(smaller)).toBe(true)
    expect(edited.output.steps.map((s) => s.state)).toEqual(['done', 'done'])
    const less = box.volumeMm3 - edited.output.volumeMm3
    expect(less).toBeGreaterThan(lost / 4 - 1)
    expect(less).toBeLessThan(lost / 4 + 1)
  })
})
