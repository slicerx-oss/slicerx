// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client sweeps one closed profile along an open path: a new body, a post joined to a base and a groove cut across
// it, each a step that replays from the saved 3MF, and the input the sweep refuses.
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

const geom = useGeomEngine('design-sweep-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

const square = (s: number) => ({ points: [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]] })
const level = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] })

describe('sweep as a design step', () => {
  it('sweeps a new body, joins a post and cuts a groove, and replays them from the saved file', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Rail' })).design
    // a straight sweep is the extrusion: 10 mm square over 20 mm
    const rail = await ok('slicerx_geom_sweep', { design: d, profile: { loops: [square(10)] }, path: { points: [[0, 0, 0], [0, 0, 20]] }, name: 'Post' })
    expect(rail.parts).toHaveLength(1)
    expect(rail.parts[0]?.name).toBe('Post')
    expect(rail.volumeMm3).toBeCloseTo(2000, 3)
    expect(rail.sizeMm[2]).toBeCloseTo(20, 3)

    // A 30 x 30 x 5 mm base, a 10 mm square post swept up 10 mm from its top, and a 4 mm square groove swept across it.
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 30 }, distance_mm: 5, name: 'Base' })
    const post = await ok('slicerx_geom_sweep', { design: d, part: 1, operation: 'join', profile: { frame: level(5), loops: [square(10)] }, path: { points: [[0, 0, 5], [0, 0, 15]] } })
    expect(post.parts[1]?.volumeMm3).toBeCloseTo(4500 + 1000, 1)
    expect(post.parts[1]?.sizeMm[2]).toBeCloseTo(15, 3)
    const groove = await ok('slicerx_geom_sweep', { design: d, part: 1, operation: 'cut', profile: { frame: { origin: [-20, 10, 2.5], normal: [1, 0, 0] }, loops: [square(4)] }, path: { points: [[-20, 10, 2.5], [20, 10, 2.5]] } })
    expect(groove.parts[1]?.volumeMm3).toBeCloseTo(5500 - 4 * 4 * 30, 1)

    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => s.op)).toEqual(['sketch.sweep', 'shape.extrude', 'sketch.sweep', 'sketch.sweep'])
    expect(steps.map((s) => s.name)).toEqual(['Sweep', 'Rectangle extrude 5 mm', 'Sweep', 'Sweep cut'])
    expect(steps.every((s) => s.state === 'done')).toBe(true)

    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.steps).toBe(4)
    expect(again.volumeMm3).toBeCloseTo(groove.volumeMm3, 1)
  }, 60_000)

  it('sweeps an open profile into a shell as a new body and joined, and replays both from the saved file', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Fins' })).design
    // a 10 mm line carried 20 mm up: a sheet 2 mm thick
    const fin = await ok('slicerx_geom_sweep', { design: d, profile: { open: true, loops: [{ points: [[0, 0], [10, 0]] }] }, path: { points: [[0, 0, 0], [0, 0, 20]] }, thicken: { thicknessMm: 2, side: 'center' } })
    expect(fin.volumeMm3).toBeCloseTo(400, 3)
    // a half pipe of 6 mm radius joined on top of a plate, 1 mm thick outward
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 30 }, distance_mm: 5, name: 'Plate' })
    const arc = Array.from({ length: 13 }, (_, i) => [6 * Math.cos(Math.PI + (Math.PI * i) / 12), 6 * Math.sin(Math.PI + (Math.PI * i) / 12)])
    const pipe = await ok('slicerx_geom_sweep', { design: d, part: 1, operation: 'join', profile: { frame: level(5), open: true, loops: [{ points: arc }] }, path: { points: [[0, 0, 5], [0, 0, 15]] }, thicken: { thicknessMm: 1 } })
    expect(pipe.parts[1]!.volumeMm3).toBeGreaterThan(4500)
    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => s.name)).toEqual(['Sweep, 2 mm shell', 'Rectangle extrude 5 mm', 'Sweep, 1 mm shell'])
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.steps).toBe(3)
    expect(again.volumeMm3).toBeCloseTo(pipe.volumeMm3, 1)
  }, 60_000)

  it('sweeps along a quarter arc drawn on a plane, close to the torus segment', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: Summary }>(await h.call('slicerx_design_new', { name: 'Elbow' })).output.design
    const r = await h.call('slicerx_geom_sweep', { design: d, profile: { frame: { origin: [20, 0, 0], normal: [0, 1, 0] }, loops: [{ type: 'circle', center: [0, 0], diameterMm: 10 }] }, path: { loops: [{ start: [20, 0], segments: [{ type: 'arc', center: [0, 0], sweepDeg: 90 }] }] } })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ output: Summary }>(r).output
    const torus = Math.PI * 25 * 20 * (Math.PI / 2)
    expect(Math.abs(out.volumeMm3 / torus - 1)).toBeLessThan(5e-3)
  }, 60_000)

  it('refuses a bend too tight, a profile along the path and input it cannot use, and leaves the design as it was', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: Summary }>(await h.call('slicerx_design_new', { name: 'X' })).output.design
    const tight = await h.call('slicerx_geom_sweep', { design: d, profile: { frame: { origin: [3, 0, 0], normal: [0, 1, 0] }, loops: [{ type: 'circle', center: [0, 0], diameterMm: 10 }] }, path: { loops: [{ start: [3, 0], segments: [{ type: 'arc', center: [0, 0], sweepDeg: 90 }] }] } })
    expect(tight.isError).toBe(true)
    expect(text(tight)).toMatch(/the path bends too tightly for the profile/)
    const along = await h.call('slicerx_geom_sweep', { design: d, profile: { loops: [square(10)] }, path: { points: [[0, 0, 0], [10, 0, 0]] } })
    expect(along.isError).toBe(true)
    expect(text(along)).toMatch(/the profile's plane is parallel to the path where the path starts/)
    const ring = await h.call('slicerx_geom_sweep', { design: d, profile: { loops: [square(10)] }, path: { points: [[0, 0, 0], [0, 0, 10], [5, 0, 10], [0, 0, 0]] } })
    expect(ring.isError).toBe(true)
    expect(text(ring)).toMatch(/a sweep path is open, with two ends/)
    const both = await h.call('slicerx_geom_sweep', { design: d, profile: { loops: [square(10)] }, path: { points: [[0, 0, 0], [0, 0, 10]], loops: [{ points: [[0, 0], [10, 0]] }] } })
    expect(both.isError).toBe(true)
    expect(text(both)).toMatch(/give loops or points, not both/)
    const none = await h.call('slicerx_geom_sweep', { design: d, profile: { loops: [square(10)] } })
    expect(none.isError).toBe(true)
    expect(text(none)).toMatch(/path: give the path/)
    expect(data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps).toHaveLength(0)
  }, 60_000)
})
