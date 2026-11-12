// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client builds a detail once and repeats it as one step: a row of windows along a house wall, a pocket of a desk
// organizer mirrored to the other side, holes round a gear. Checked by volume and size, with the count edited later,
// saved and opened again, and refused in words when a step cannot be repeated.
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
  note?: string
  value?: { label: string; value: number; unit: string }
}

const geom = useGeomEngine('feature-pattern-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

async function client() {
  const h = await connect({ geomEngine: engine })
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  const steps = async (design: string): Promise<Row[]> => data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design })).output.steps
  return { h, ok, steps }
}

describe('repeating steps as one step', () => {
  it('repeats a window along a house wall, and the count edits later', async () => {
    const { h, ok, steps } = await client()
    const d = (await ok('slicerx_design_new', { name: 'House' })).design
    // A wall 60 mm long, 10 mm thick and 30 mm high, its front face at y = -5.
    const wall = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 60, heightMm: 10 }, distance_mm: 30 })
    expect(wall.volumeMm3).toBeCloseTo(18_000, 1)
    // One window, 6 x 8 mm, cut through the wall near its left end.
    const one = await ok('slicerx_geom_extrude', { design: d, part: 0, feature: 'window', shape: { type: 'rectangle', widthMm: 6, heightMm: 8 }, frame: { origin: [-20, -5, 15], normal: [0, -1, 0] }, distance_mm: 10, operation: 'cut' })
    expect(one.volumeMm3).toBeCloseTo(18_000 - 480, 1)

    // Five windows 10 mm apart, by the plan feature's name.
    const row = await ok('slicerx_geom_array', { design: d, steps: ['window'], spec: { kind: 'linear', count: 5, step: [10, 0, 0] } })
    expect(row.steps).toBe(3)
    expect(row.parts).toHaveLength(1)
    expect(row.volumeMm3).toBeCloseTo(18_000 - 5 * 480, 1)
    expect(row.sizeMm[0]).toBeCloseTo(60, 3)
    const rows = await steps(d)
    expect(rows.map((r) => r.op)).toEqual(['shape.extrude', 'shape.extrude', 'pattern'])
    expect(rows[2]).toMatchObject({ name: 'Pattern of 5, 1 step', state: 'done', value: { label: 'Copies', value: 5 } })

    // Three windows instead: the count is the step's value.
    const fewer = await h.call('slicerx_design_edit_step', { design: d, step: 3, value: 3 })
    expect(fewer.isError, text(fewer)).toBeFalsy()
    expect(data<{ output: Summary }>(fewer).output.volumeMm3).toBeCloseTo(18_000 - 3 * 480, 1)
    const half = await h.call('slicerx_design_edit_step', { design: d, step: 3, value: 2.5 })
    expect(half.isError).toBe(true)
    expect(text(half)).toMatch(/at least 2 copies/)

    // Shallow windows, 4 mm deep: every copy follows the step it repeats.
    const shallow = await h.call('slicerx_design_edit_step', { design: d, step: 2, value: 4 })
    expect(shallow.isError, text(shallow)).toBeFalsy()
    expect(data<{ output: Summary }>(shallow).output.volumeMm3).toBeCloseTo(18_000 - 3 * 192, 1)

    // Saved and opened again, it replays to the same wall.
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.steps).toBe(3)
    expect(again.volumeMm3).toBeCloseTo(18_000 - 3 * 192, 1)
  }, 60_000)

  it('mirrors a pocket of a desk organizer to the other side', async () => {
    const { ok, steps } = await client()
    const d = (await ok('slicerx_design_new', { name: 'Desk organizer' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 80, heightMm: 40 }, distance_mm: 30 })
    // A 20 x 20 mm pocket, 20 mm deep, from the top on the right.
    await ok('slicerx_geom_extrude', { design: d, part: 0, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, frame: { origin: [25, 0, 30], normal: [0, 0, 1] }, distance_mm: 20, operation: 'cut' })
    const both = await ok('slicerx_geom_mirror', { design: d, steps: [2], plane: { axis: 'x', at: 0 } })
    expect(both.parts).toHaveLength(1)
    expect(both.sizeMm[0]).toBeCloseTo(80, 3)
    expect(both.volumeMm3).toBeCloseTo(80 * 40 * 30 - 2 * 8000, 1)
    expect((await steps(d))[2]).toMatchObject({ op: 'pattern', name: 'Mirror of 1 step', state: 'done' })
  }, 60_000)

  it('repeats a hole round a gear blank', async () => {
    const { ok } = await client()
    const d = (await ok('slicerx_design_new', { name: 'Gear' })).design
    const blank = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 40 }, distance_mm: 5 })
    const holed = await ok('slicerx_geom_extrude', { design: d, part: 0, shape: { type: 'circle', diameterMm: 4 }, frame: { origin: [12, 0, 5], normal: [0, 0, 1] }, distance_mm: 5, operation: 'cut' })
    const hole = blank.volumeMm3 - holed.volumeMm3
    expect(hole).toBeGreaterThan(55)
    const ring = await ok('slicerx_geom_array', { design: d, steps: [2], spec: { kind: 'circular', count: 6, center: [0, 0, 0] } })
    expect(ring.volumeMm3).toBeCloseTo(blank.volumeMm3 - 6 * hole, 0)
    expect(ring.sizeMm[0]).toBeCloseTo(blank.sizeMm[0], 3)
  }, 60_000)

  it('says why a step cannot be repeated', async () => {
    const { h, ok, steps } = await client()
    const d = (await ok('slicerx_design_new', { name: 'Toy boat' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 60, heightMm: 20 }, distance_mm: 10 })
    await ok('slicerx_geom_extrude', { design: d, part: 0, shape: { type: 'circle', diameterMm: 4 }, frame: { origin: [-20, -10, 5], normal: [0, -1, 0] }, distance_mm: 2, operation: 'cut' })
    const body = await h.call('slicerx_geom_array', { design: d, steps: [1], spec: { kind: 'linear', count: 3, step: [10, 0, 0] } })
    expect(body.isError).toBe(true)
    expect(text(body)).toMatch(/makes a new body, so array that part instead/)
    const apart = await h.call('slicerx_geom_array', { design: d, steps: [2], merge: false, spec: { kind: 'linear', count: 3, step: [10, 0, 0] } })
    expect(apart.isError).toBe(true)
    expect(text(apart)).toMatch(/repeated steps stay on their part/)
    const many = await h.call('slicerx_geom_array', { design: d, steps: [2], spec: { kind: 'linear', count: 11, count2: 11, step: [1, 0, 0], step2: [0, 0, 1] } })
    expect(many.isError).toBe(true)
    expect(text(many)).toMatch(/at most 100 copies; this one has 121/)
    const flipped = await h.call('slicerx_geom_mirror', { design: d, steps: [2], copy: false, plane: { axis: 'y', at: 0 } })
    expect(flipped.isError).toBe(true)
    expect(text(flipped)).toMatch(/keeps them and adds their mirror image/)
    // A row that runs off the hull keeps the copies that land and names the one that misses, in the reply and the step.
    const off = await h.call('slicerx_geom_array', { design: d, steps: [2], spec: { kind: 'linear', count: 4, step: [20, 0, 0] } })
    expect(off.isError, text(off)).toBeFalsy()
    expect(text(off)).toMatch(/Copy 4 did not reach the part and was left out/)
    const rows = await steps(d)
    expect(rows.map((r) => r.op)).toEqual(['shape.extrude', 'shape.extrude', 'pattern'])
    expect(rows[2]).toMatchObject({ state: 'done', note: 'Copy 4 did not reach the part and was left out.' })
  }, 60_000)
})
