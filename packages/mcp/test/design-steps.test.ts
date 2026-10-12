// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client builds a stand from halves the way a maker would: two bodies joined, mirrored into a whole, arrayed,
// cut in two and split to fit, each one a step in the design's history. Checked by size, volume and parts, saved,
// opened again and edited.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Summary {
  design: string
  steps: number
  sizeMm: V3
  minMm: V3
  volumeMm3: number
  parts: { name: string; sizeMm: V3; minMm: V3; volumeMm3: number }[]
}
interface Row {
  name: string
  op: string
  state: string
}

const geom = useGeomEngine('design-steps-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

describe('steps that change parts', () => {
  it('joins, mirrors, arrays, cuts and splits as steps, and replays them after an edit', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Stand' })).design
    // A 20 x 10 x 4 mm foot and a 6 x 10 x 12 mm upright at its end, as two bodies.
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, placement: { center: [10, 0] }, distance_mm: 4 })
    const two = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 6, heightMm: 10 }, placement: { center: [17, 0] }, distance_mm: 12 })
    expect(two.parts).toHaveLength(2)

    const joined = await ok('slicerx_geom_boolean', { op: 'union', design: d, part: 0, with_parts: [1] })
    expect(joined.parts).toHaveLength(1)
    expect(joined.volumeMm3).toBeCloseTo(800 + 720 - 240, 1)

    const whole = await ok('slicerx_geom_mirror', { design: d, plane: { axis: 'x', at: 0 } })
    expect(whole.sizeMm[0]).toBeCloseTo(40, 3)
    expect(whole.minMm[0]).toBeCloseTo(-20, 3)
    expect(whole.volumeMm3).toBeCloseTo(2 * 1280, 1)

    const row = await ok('slicerx_geom_array', { design: d, part: 0, spec: { kind: 'linear', count: 2, step: [0, 15, 0] } })
    expect(row.sizeMm[1]).toBeCloseTo(25, 3)
    expect(row.volumeMm3).toBeCloseTo(4 * 1280, 1)

    const cut = await ok('slicerx_geom_cut', { design: d, part: 0, plane: { axis: 'z', at: 2 } })
    expect(cut.parts).toHaveLength(2)
    expect(cut.parts[0]?.sizeMm[2]).toBeCloseTo(2, 3)
    expect(cut.parts[1]?.minMm[2]).toBeCloseTo(2, 3)
    expect(cut.parts[1]?.name).toMatch(/top$/)
    expect(cut.volumeMm3).toBeCloseTo(row.volumeMm3, 1)

    // The top piece is 40 mm wide: it does not fit a 30 mm printer, so it splits.
    const split = await ok('slicerx_geom_split', { design: d, part: 1, build_volume_mm: [30, 30, 30] })
    expect(split.parts.length).toBeGreaterThan(2)
    for (const p of split.parts.slice(1)) expect(Math.max(...p.sizeMm)).toBeLessThanOrEqual(30)
    expect(split.volumeMm3).toBeCloseTo(row.volumeMm3, 0)

    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => s.op)).toEqual(['shape.extrude', 'shape.extrude', 'boolean', 'mirror', 'array.merged', 'plane.cut', 'split'])
    expect(steps.map((s) => s.name)).toEqual(['Rectangle extrude 4 mm', 'Rectangle extrude 12 mm', 'Join 1 part', 'Mirror copy', 'Array of 2, merged', 'Cut in two', 'Split to fit 30 x 30 x 30 mm'])
    expect(steps.every((s) => s.state === 'done')).toBe(true)

    // Saved and opened again, it replays to the same parts.
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.steps).toBe(7)
    expect(again.parts).toHaveLength(split.parts.length)
    expect(again.volumeMm3).toBeCloseTo(split.volumeMm3, 1)

    // A taller upright: every later step replays on it.
    const edited = await h.call('slicerx_design_edit_step', { design: again.design, step: 2, value: 16 })
    expect(edited.isError, text(edited)).toBeFalsy()
    const out = data<{ output: Summary & { steps: Row[] } }>(edited).output
    expect(out.steps.every((s) => s.state === 'done')).toBe(true)
    expect(out.sizeMm[2]).toBeCloseTo(16, 3)

    // Moving the cut plane is an edit of its number.
    const lower = await h.call('slicerx_design_edit_step', { design: again.design, step: 6, value: 1 })
    expect(lower.isError, text(lower)).toBeFalsy()
    expect(data<{ output: Summary }>(lower).output.parts[0]?.sizeMm[2]).toBeCloseTo(1, 3)
  }, 60_000)

  it('refuses what a design step cannot do yet, and says so', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: Summary }>(await h.call('slicerx_design_new', { name: 'X' })).output.design
    const r = await h.call('slicerx_geom_cut', { design: d, plane: { axis: 'z', at: 1 }, connector: { kind: 'pin' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/not_supported/)
  })
})
