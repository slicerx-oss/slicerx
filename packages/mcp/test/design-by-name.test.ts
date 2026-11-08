// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client names a design by its title where its id goes, and a join or cut by its part's name in target: the design
// of that name is the one changed, a name two designs share is refused with both ids, and a target lands on the part
// it names (or is refused when it names no part, two parts, or a part other than the one given as part).
import { designNamed, noDesignMessage } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Summary {
  design: string
  parts: { name: string; sizeMm: V3; volumeMm3: number }[]
}

const geom = useGeomEngine('design-by-name')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

describe('designNamed and noDesignMessage', () => {
  const tools = { start: 'design.new', list: 'design.list' }
  const d = (id: string, name: string) => ({ id, name })

  it('takes the one design of that name, case and spacing aside, and nothing for no match or two', () => {
    const all = [d('obj_1', 'Hinged box'), d('obj_2', 'Clip'), d('obj_3', 'Clip')]
    expect(designNamed(all, 'Hinged box')?.id).toBe('obj_1')
    expect(designNamed(all, '  hinged   BOX ')?.id).toBe('obj_1')
    expect(designNamed(all, 'Lid')).toBeUndefined()
    expect(designNamed(all, 'clip')).toBeUndefined()
  })

  it('says how to start a design when there are none, lists up to five ids, and says when a name is shared', () => {
    expect(noDesignMessage('Box', [], tools)).toBe('design: no design Box; there are no designs yet, so start one with design.new and use the id it returns')
    expect(noDesignMessage('Lid', [d('obj_1', 'Box')], tools)).toBe('design: no design Lid; give a design id, such as obj_1 (Box)')
    const six = [1, 2, 3, 4, 5, 6].map((n) => d(`obj_${n}`, `Part ${n}`))
    const many = noDesignMessage('Lid', six, tools)
    expect(many).toMatch(/such as obj_2 \(Part 2\), obj_3 \(Part 3\), obj_4 \(Part 4\), obj_5 \(Part 5\), obj_6 \(Part 6\); design\.list lists them all$/)
    expect(many).not.toContain('obj_1 ')
    expect(noDesignMessage('clip', [d('obj_1', 'Box'), d('obj_2', 'Clip'), d('obj_3', 'Clip')], tools)).toBe('design: 2 designs are named clip; give one of these ids: obj_2 (Clip), obj_3 (Clip)')
  })
})

describe('a design and its part by name', () => {
  const box = (w: number, h: number) => ({ type: 'rectangle', widthMm: w, heightMm: h })

  async function setup() {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Hinged box' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: box(40, 30), placement: { center: [20, 15] }, distance_mm: 10, name: 'Body' })
    const { parts } = await ok('slicerx_geom_extrude', { design: d, shape: box(40, 30), placement: { center: [80, 15] }, distance_mm: 4, name: 'Lid' })
    return { h, ok, d, parts }
  }

  it('changes the design named by its title, and refuses a name two designs share with both ids', async () => {
    const { h, ok, d } = await setup()
    const other = (await ok('slicerx_design_new', { name: 'Clip' })).design
    const r = await ok('slicerx_geom_extrude', { design: 'hinged  BOX', shape: box(10, 10), placement: { center: [20, 15] }, distance_mm: 3, name: 'Tab' })
    expect(r.design).toBe(d)
    expect(r.parts.map((p) => p.name)).toEqual(['Body', 'Lid', 'Tab'])
    const unknown = await h.call('slicerx_geom_extrude', { design: 'Lid', shape: box(10, 10), distance_mm: 3 })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toMatch(/no design Lid; give a design id, such as .*\(Hinged box\)/)
    const twin = (await ok('slicerx_design_new', { name: 'Clip' })).design
    const shared = await h.call('slicerx_geom_extrude', { design: 'clip', shape: box(10, 10), distance_mm: 3 })
    expect(shared.isError).toBe(true)
    expect(text(shared)).toContain(`2 designs are named clip; give one of these ids: ${other} (Clip), ${twin} (Clip)`)
  }, 60_000)

  it('lands a join on the part its target names, with each of extrude, revolve, loft and sweep', async () => {
    const { ok, d, parts: before } = await setup()
    const lid0 = before[1]!.volumeMm3
    const body0 = before[0]!.volumeMm3
    // a 10 mm boss on the lid's top, by extrude
    let r = await ok('slicerx_geom_extrude', { design: d, target: 'Lid', operation: 'join', frame: { origin: [0, 0, 4], normal: [0, 0, 1] }, shape: { type: 'circle', diameterMm: 10 }, placement: { center: [80, 15] }, distance_mm: 5 })
    expect(r.parts[1]!.volumeMm3).toBeGreaterThan(lid0 + 300)
    expect(r.parts[0]!.volumeMm3).toBeCloseTo(body0, 3)
    let lid = r.parts[1]!.volumeMm3
    // a half ring on the lid, by revolve about a line along x through the lid's top
    r = await ok('slicerx_geom_revolve', { design: d, target: 'lid', operation: 'join', frame: { origin: [0, 15, 0], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, loops: [{ points: [[66, 4], [70, 4], [70, 8], [66, 8]] }], axis: { point: [0, 4], direction: [1, 0] }, angle_deg: 180 })
    expect(r.parts[1]!.volumeMm3).toBeGreaterThan(lid)
    expect(r.parts[0]!.volumeMm3).toBeCloseTo(body0, 3)
    lid = r.parts[1]!.volumeMm3
    // a tapered post on the lid, by loft
    const sq = (z: number, s: number) => ({ frame: { origin: [0, 0, z], normal: [0, 0, 1] }, loops: [{ points: [[90 - s, 15 - s], [90 + s, 15 - s], [90 + s, 15 + s], [90 - s, 15 + s]] }] })
    r = await ok('slicerx_geom_loft', { design: d, target: 'Lid', operation: 'join', profiles: [sq(3, 4), sq(12, 2)] })
    expect(r.parts[1]!.volumeMm3).toBeGreaterThan(lid)
    expect(r.parts[0]!.volumeMm3).toBeCloseTo(body0, 3)
    lid = r.parts[1]!.volumeMm3
    // a rod swept up out of the lid, by sweep
    r = await ok('slicerx_geom_sweep', { design: d, target: 'Lid', operation: 'join', profile: { frame: { origin: [0, 0, 2], normal: [0, 0, 1] }, loops: [{ type: 'circle', center: [70, 15], diameterMm: 4 }] }, path: { points: [[70, 15, 2], [70, 15, 14]] } })
    expect(r.parts[1]!.volumeMm3).toBeGreaterThan(lid)
    expect(r.parts[0]!.volumeMm3).toBeCloseTo(body0, 3)
  }, 60_000)

  it('refuses a target that names another part than part, two parts, or no part, and takes the design itself as part', async () => {
    const { h, ok, d } = await setup()
    const boss = { operation: 'join', frame: { origin: [0, 0, 4], normal: [0, 0, 1] }, shape: { type: 'circle', diameterMm: 6 }, placement: { center: [80, 15] }, distance_mm: 2 }
    const clash = await h.call('slicerx_geom_extrude', { design: d, target: 'Lid', part: 0, ...boss })
    expect(clash.isError).toBe(true)
    expect(text(clash)).toMatch(/target: Lid is part 1 \(Lid\), but part is 0 \(Body\); give one of them/)
    // the same part both ways goes through
    await ok('slicerx_geom_extrude', { design: d, target: 'Lid', part: 1, ...boss })
    const none = await h.call('slicerx_geom_extrude', { design: d, target: 'hinge pin', ...boss })
    expect(text(none)).toMatch(/leave target out and give part, one of 0 \(Body\), 1 \(Lid\)/)
    // the design itself stands for part, which defaults to 0
    const self = await ok('slicerx_geom_extrude', { design: d, target: 'Hinged box', ...boss, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, placement: { center: [20, 15] } })
    expect(self.parts[0]!.volumeMm3).toBeGreaterThan(40 * 30 * 10)
    // a second part named Lid makes the name ambiguous
    await ok('slicerx_geom_extrude', { design: d, shape: box(20, 20), placement: { center: [140, 15] }, distance_mm: 4, name: 'Lid' })
    const two = await h.call('slicerx_geom_extrude', { design: d, target: 'Lid', ...boss })
    expect(text(two)).toMatch(/target: 2 parts are named Lid \(1, 2\); leave target out and give part/)
  }, 60_000)
})
