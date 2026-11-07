// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client lofts through profiles on their own planes: a new body from a square to a circle, a tapered post joined to
// a base, smooth sides and a thickened open shell, each a step that replays from the saved 3MF, and the input the loft
// refuses.
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

const geom = useGeomEngine('design-loft-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

const square = (s: number) => ({ points: [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]] })
const level = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] })

describe('loft as a design step', () => {
  it('lofts a new body and a joined post, and replays both from the saved file', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Vase foot' })).design
    const vase = await ok('slicerx_geom_loft', { design: d, profiles: [{ loops: [square(20)] }, { frame: level(30), loops: [{ type: 'circle', center: [0, 0], diameterMm: 10 }] }], name: 'Neck' })
    expect(vase.parts).toHaveLength(1)
    expect(vase.parts[0]?.name).toBe('Neck')
    expect(vase.sizeMm[0]).toBeCloseTo(20, 3)
    expect(vase.sizeMm[2]).toBeCloseTo(30, 3)
    expect(vase.volumeMm3).toBeGreaterThan(30 * 78.5)
    expect(vase.volumeMm3).toBeLessThan(30 * 400)

    // A 30 x 30 x 5 mm base, then a post tapering from 20 to 10 mm square over 10 mm, joined on top of it.
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 30 }, distance_mm: 5, name: 'Base' })
    const post = await ok('slicerx_geom_loft', { design: d, part: 1, operation: 'join', profiles: [{ frame: level(5), loops: [square(20)] }, { frame: level(15), loops: [square(10)] }] })
    expect(post.parts).toHaveLength(2)
    expect(post.parts[1]?.volumeMm3).toBeCloseTo(4500 + (10 / 3) * (400 + 100 + 200), 1)
    expect(post.parts[1]?.sizeMm[2]).toBeCloseTo(15, 3)

    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => s.op)).toEqual(['sketch.loft', 'shape.extrude', 'sketch.loft'])
    expect(steps.map((s) => s.name)).toEqual(['Loft, 2 profiles', 'Rectangle extrude 5 mm', 'Loft, 2 profiles'])
    expect(steps.every((s) => s.state === 'done')).toBe(true)

    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.steps).toBe(3)
    expect(again.volumeMm3).toBeCloseTo(post.volumeMm3, 1)
  }, 60_000)

  it('refuses profiles that cross and input it cannot use, and leaves the design as it was', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: Summary }>(await h.call('slicerx_design_new', { name: 'X' })).output.design
    const crossing = await h.call('slicerx_geom_loft', { design: d, profiles: [{ loops: [square(10)] }, { frame: { origin: [0, 0, 2], normal: [1, 0, 0.2] }, loops: [square(30)] }] })
    expect(crossing.isError).toBe(true)
    expect(text(crossing)).toMatch(/profiles 1 and 2 touch or cross/)
    const holed = await h.call('slicerx_geom_loft', { design: d, profiles: [{ loops: [square(10), square(4)] }, { frame: level(10), loops: [square(10)] }] })
    expect(holed.isError).toBe(true)
    expect(text(holed)).toMatch(/profile 1: a loft profile has no holes yet/)
    const one = await h.call('slicerx_geom_loft', { design: d, profiles: [{ loops: [square(10)] }] })
    expect(one.isError).toBe(true)
    const both = await h.call('slicerx_geom_loft', { design: d, profiles: [{ loops: [square(10)] }, { frame: level(10), loops: [square(10)] }], sketches: ['s1', 's2'] })
    expect(both.isError).toBe(true)
    expect(text(both)).toMatch(/profiles or sketches, not both/)
    // the schema only points at revolve's frame and loops, so the tool still checks them as revolve does
    const noSize = await h.call('slicerx_geom_loft', { design: d, profiles: [{ loops: [{ type: 'circle', center: [0, 0] }] }, { frame: level(10), loops: [square(10)] }] })
    expect(noSize.isError).toBe(true)
    expect(text(noSize)).toMatch(/profiles\W+0\W+loops\W+0/)
    const noNormal = await h.call('slicerx_geom_loft', { design: d, profiles: [{ loops: [square(10)] }, { frame: { origin: [0, 0, 10] }, loops: [square(10)] }] })
    expect(noNormal.isError).toBe(true)
    expect(text(noNormal)).toMatch(/profiles\W+1\W+frame\W+normal/)
    expect(data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps).toHaveLength(0)
  }, 60_000)

  it('lofts smooth sides and a thickened open shell as steps that replay', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    // eight-sided rings keep the recorded replies small
    const circle = (x: number, d: number) => ({ points: Array.from({ length: 8 }, (_, k) => [x + (d / 2) * Math.cos((k * Math.PI) / 4), (d / 2) * Math.sin((k * Math.PI) / 4)]) })
    const d = (await ok('slicerx_design_new', { name: 'Freeform' })).design
    // a bent tube: smooth through three circles, so it bulges past the middle one's own reach
    const bent = await ok('slicerx_geom_loft', { design: d, smooth: true, profiles: [{ loops: [circle(0, 10)] }, { frame: level(10), loops: [circle(8, 10)] }, { frame: level(20), loops: [circle(0, 10)] }] })
    expect(bent.sizeMm[2]).toBeCloseTo(20, 3)
    // a half pipe from open arcs, thickened 1.5 mm outward
    const arc = (r: number) => Array.from({ length: 13 }, (_, i) => [r * Math.cos(Math.PI + (Math.PI * i) / 12), r * Math.sin(Math.PI + (Math.PI * i) / 12)])
    const pipe = await ok('slicerx_geom_loft', { design: d, thicken: { thicknessMm: 1.5 }, profiles: [{ frame: { origin: [40, 0, 0], normal: [0, 0, 1] }, open: true, loops: [{ points: arc(6) }] }, { frame: { origin: [40, 0, 20], normal: [0, 0, 1] }, open: true, loops: [{ points: arc(6) }] }] })
    expect(pipe.parts).toHaveLength(2)
    expect(pipe.parts[1]!.volumeMm3 / ((Math.PI / 2) * (7.5 * 7.5 - 36) * 20)).toBeCloseTo(1, 1)

    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => s.name)).toEqual(['Smooth loft, 3 profiles', 'Loft, 2 profiles, 1.5 mm shell'])
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.volumeMm3).toBeCloseTo(pipe.volumeMm3, 1)

    // an open profile alone makes no solid, and a bad thickness names its field
    const bare = await h.call('slicerx_geom_loft', { design: d, profiles: [{ open: true, loops: [{ points: arc(6) }] }, { frame: level(10), open: true, loops: [{ points: arc(6) }] }] })
    expect(text(bare)).toMatch(/thicken: open profiles make a surface; give thicken to make it a solid/)
    const thin = await h.call('slicerx_geom_loft', { design: d, thicken: { thicknessMm: 0 }, profiles: [{ loops: [square(10)] }, { frame: level(10), loops: [square(10)] }] })
    expect(text(thin)).toMatch(/thicken\W+thicknessMm/)
    const mark = await h.call('slicerx_geom_loft', { design: d, profiles: [{ loops: [square(10)], landmarks: [[0, 0, 0]] }, { frame: level(10), loops: [square(10)] }] })
    expect(text(mark)).toMatch(/profiles\W+0\W+landmarks\W+0/)
    expect(data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps).toHaveLength(2)
  }, 60_000)

  it('lofts a ring, joins a smooth loft, cuts a thickened one and lofts by landmarks, all replayed from the saved file', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const oct = (r: number) => ({ points: Array.from({ length: 8 }, (_, k) => [r * Math.cos((k * Math.PI) / 4), r * Math.sin((k * Math.PI) / 4)]) })
    const around = (deg: number) => ({ origin: [20 * Math.cos((deg * Math.PI) / 180), 20 * Math.sin((deg * Math.PI) / 180), 0], normal: [-Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180), 0] })
    const d = (await ok('slicerx_design_new', { name: 'Rings' })).design
    // a ring of four octagons around the z axis: no ends, so its volume is all sides
    const ring = await ok('slicerx_geom_loft', { design: d, closed: true, profiles: [0, 90, 180, 270].map((a) => ({ frame: around(a), loops: [oct(3)] })) })
    expect(ring.volumeMm3).toBeGreaterThan(0)
    const two = await h.call('slicerx_geom_loft', { design: d, closed: true, profiles: [{ loops: [square(10)] }, { frame: level(10), loops: [square(10)] }] })
    expect(text(two)).toMatch(/a closed loft needs 3 or more profiles/)

    // a 40 x 40 x 5 mm plate; a smooth post joined on it, then a thickened ring cut into the post
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 40, heightMm: 40 }, distance_mm: 5, name: 'Plate' })
    const joined = await ok('slicerx_geom_loft', { design: d, part: 1, operation: 'join', smooth: true, profiles: [{ frame: level(5), loops: [oct(8)] }, { frame: level(15), loops: [oct(5)] }, { frame: level(25), loops: [oct(7)] }] })
    const cut = await ok('slicerx_geom_loft', { design: d, part: 1, operation: 'cut', thicken: { thicknessMm: 1, side: 'center' }, profiles: [{ frame: level(10), loops: [oct(6)] }, { frame: level(20), loops: [oct(6)] }] })
    expect(cut.parts[1]!.volumeMm3).toBeLessThan(joined.parts[1]!.volumeMm3)
    // landmarks: two squares matched corner to corner, three corners marked on each
    const marked = await ok('slicerx_geom_loft', { design: d, profiles: [{ frame: level(30), loops: [square(20)], landmarks: [[-10, -10], [10, -10], [10, 10]] }, { frame: level(40), loops: [square(10)], landmarks: [[-5, -5], [5, -5], [5, 5]] }] })
    expect(marked.parts[2]!.volumeMm3).toBeCloseTo((10 / 3) * (400 + 100 + 200), 3)

    const steps = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps.map((s) => s.name)).toEqual(['Loft ring, 4 profiles', 'Rectangle extrude 5 mm', 'Smooth loft, 3 profiles', 'Loft cut, 2 profiles, 1 mm shell', 'Loft, 2 profiles'])
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const again = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
    expect(again.steps).toBe(5)
    expect(again.parts.map((p) => p.volumeMm3)).toEqual(marked.parts.map((p) => expect.closeTo(p.volumeMm3, 1)))
  }, 60_000)
})
