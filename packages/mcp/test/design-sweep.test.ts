// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client sweeps one closed profile along an open path: a new body, a post joined to a base and a groove cut across
// it, a spout that narrows and turns, a tube and a spout with their bores, each a step that replays from the saved 3MF,
// and the input the sweep refuses.
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

  it('sweeps a spout that narrows and turns along its path, and replays the taper and twist from the saved file', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Spout' })).design
    // 22 mm round at the base to 9 mm over 70 mm: the frustum
    const cone = await ok('slicerx_geom_sweep', { design: d, profile: { loops: [{ type: 'circle', center: [0, 0], diameterMm: 22 }] }, path: { points: [[0, 0, 0], [0, 0, 70]] }, scale: 9 / 22, name: 'Cone' })
    const frustum = (Math.PI * 70 * (11 * 11 + 11 * 4.5 + 4.5 * 4.5)) / 3
    expect(Math.abs(cone.volumeMm3 / frustum - 1)).toBeLessThan(5e-3)
    expect(cone.sizeMm[2]).toBeCloseTo(70, 3)
    // a 10 mm square turned a quarter about a smooth path of points as it shrinks to half, eased
    const square10 = { frame: { origin: [40, 0, 0], normal: [0, 0, 1] }, loops: [square(10)] }
    const arm = await ok('slicerx_geom_sweep', { design: d, profile: square10, path: { points: [[40, 0, 0], [40, 0, 30], [55, 0, 50], [80, 0, 55]], smooth: true }, scale: 0.5, twist_deg: 90, ease: 'smooth', name: 'Arm' })
    expect(arm.parts).toHaveLength(2)
    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => s.name)).toEqual(['Sweep, tapered', 'Sweep, tapered, twisted'])
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.steps).toBe(2)
    expect(again.parts.map((p) => p.volumeMm3)).toEqual(arm.parts.map((p) => expect.closeTo(p.volumeMm3, 1)))
  }, 60_000)

  it('sweeps a tube and a bent spout with their bores, keeps both loops on the step, and replays them from the saved file', async () => {
    const sent: { op: string; request: unknown }[] = []
    const h = await connect({ geomEngine: (op, request) => (sent.push({ op, request }), engine(op, request)) })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Spout' })).design
    // a 20 mm round with a 16 mm bore, 40 mm long: the ring's area times the length
    const ring = [{ type: 'circle', center: [0, 0], diameterMm: 20 }, { type: 'circle', center: [0, 0], diameterMm: 16 }]
    const tube = await ok('slicerx_geom_sweep', { design: d, profile: { loops: ring }, path: { points: [[0, 0, 0], [0, 0, 40]] }, name: 'Tube' })
    expect(Math.abs(tube.volumeMm3 / (Math.PI * (100 - 64) * 40) - 1)).toBeLessThan(5e-3)
    const swept = sent.filter((s) => s.op === 'sketch.sweep').at(-1)?.request as { profile: { loops: unknown[] } }
    expect(swept.profile.loops).toHaveLength(2)
    // the same ring up a quarter bend of 30 mm, narrowing to half: the bore narrows with it
    const bend = { loops: [{ start: [60, 0], segments: [{ type: 'arc', center: [30, 0], sweepDeg: 90 }] }] }
    const spout = await ok('slicerx_geom_sweep', { design: d, profile: { frame: { origin: [60, 0, 0], normal: [0, 1, 0] }, loops: ring }, path: bend, scale: 0.5, name: 'Spout' })
    expect(spout.parts).toHaveLength(2)
    // between the narrow end's ring and the wide one's along the arc
    const arc = 30 * (Math.PI / 2)
    const wide = Math.PI * (100 - 64)
    expect(spout.parts[1]!.volumeMm3).toBeGreaterThan(wide * 0.25 * arc)
    expect(spout.parts[1]!.volumeMm3).toBeLessThan(wide * arc)
    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => s.name)).toEqual(['Sweep', 'Sweep, tapered'])
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.steps).toBe(2)
    expect(again.parts.map((p) => p.volumeMm3)).toEqual(spout.parts.map((p) => expect.closeTo(p.volumeMm3, 1)))
  }, 60_000)

  it('refuses a bore that touches the outside and a thickened profile with holes, and leaves the design as it was', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: Summary }>(await h.call('slicerx_design_new', { name: 'Pipe' })).output.design
    const up = { points: [[0, 0, 0], [0, 0, 10]] }
    const touching = await h.call('slicerx_geom_sweep', { design: d, profile: { loops: [square(20), { points: [[0, -10], [5, -5], [-5, -5]] }] }, path: up })
    expect(touching.isError).toBe(true)
    expect(text(touching)).toMatch(/Loop 2 crosses loop 1/)
    const ring = [{ type: 'circle', center: [0, 0], diameterMm: 20 }, { type: 'circle', center: [0, 0], diameterMm: 16 }]
    const shell = await h.call('slicerx_geom_sweep', { design: d, profile: { loops: ring }, path: up, thicken: { thicknessMm: 1 } })
    expect(shell.isError).toBe(true)
    expect(text(shell)).toMatch(/a profile with holes already has its walls; leave thicken out/)
    expect(data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps).toHaveLength(0)
  }, 60_000)

  it('refuses a taper that crosses itself at a tight bend, naming the bend, and a scale too small', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: Summary }>(await h.call('slicerx_design_new', { name: 'Horn' })).output.design
    const side = { frame: { origin: [8, 0, 0], normal: [0, 1, 0] }, loops: [{ type: 'circle', center: [0, 0], diameterMm: 10 }] }
    const bend = { loops: [{ start: [8, 0], segments: [{ type: 'arc', center: [0, 0], sweepDeg: 90 }] }] }
    const big = await h.call('slicerx_geom_sweep', { design: d, profile: side, path: bend, scale: 3 })
    expect(big.isError).toBe(true)
    expect(text(big)).toMatch(/the path bends too tightly for the profile near \(-?\d+\.\d\d, -?\d+\.\d\d, -?\d+\.\d\d\) mm/)
    expect(text(big)).toMatch(/or end scale/)
    const tiny = await h.call('slicerx_geom_sweep', { design: d, profile: side, path: bend, scale: 0.01 })
    expect(tiny.isError).toBe(true)
    expect(text(tiny)).toMatch(/scale: /)
    expect(data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps).toHaveLength(0)
  }, 60_000)

  it('refuses a profile drawn at bed X and Y on a frame already at the path start, saying where it sits', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: Summary }>(await h.call('slicerx_design_new', { name: 'Stand' })).output.design
    // the hook as a live build sent it: the frame on the path's start, the circle at that point's bed X and Y again
    const off = await h.call('slicerx_geom_sweep', { design: d, operation: 'new', profile: { frame: { origin: [128, 128, 150], normal: [0, 0, 1] }, loops: [{ type: 'circle', center: [128, 128], diameterMm: 12 }] }, path: { points: [[128, 128, 150], [128, 128, 158], [138, 128, 168], [188, 128, 168]] } })
    expect(off.isError).toBe(true)
    expect(text(off)).toMatch(/its loop sits 181\.02 mm from where the path starts \(128, 128, 150\)/)
    expect(text(off)).toMatch(/centered at \[0, 0\]/)
    // the same on a path drawn on a plane
    const drawn = await h.call('slicerx_geom_sweep', { design: d, profile: { frame: { origin: [0, 40, 0], normal: [0, 1, 0] }, loops: [square(10)] }, path: { frame: { origin: [0, 0, 0], normal: [0, 0, 1] }, loops: [{ points: [[0, 0], [0, 50]] }] } })
    expect(drawn.isError).toBe(true)
    expect(text(drawn)).toMatch(/its loop sits 40 mm from where the path starts \(0, 0, 0\)/)
    expect(data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps).toHaveLength(0)
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
