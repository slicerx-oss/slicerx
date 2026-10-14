// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client makes a hole another size the way the hole tool does: picked by its axis or by a point on its wall, made
// narrower with a counterbore or shallower, as the same hole step the app records, and read back before and after.
// A pick that finds no hole says what face is there, and leaves the design as it was.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Read {
  center: V3
  axis: V3
  diameterMm: number
  depthMm: number
  kind: 'through' | 'blind'
  head?: string
  counterbore?: { diameterMm: number; depthMm: number }
}
interface Out {
  design: string
  steps: number
  volumeMm3: number
  part: number
  before: Read
  after: Read
  lastStep: { name: string; op: string; state: string; value?: { label: string; value: number } }
}

const geom = useGeomEngine('design-hole-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)
const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] })

describe('a hole made another size on a design', () => {
  it('finds a hole by its axis, makes it an M3 counterbore as the hole step, and reads it back', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Plate' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 5 })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 6 }, frame: top(5), placement: { center: [15, 10] }, distance_mm: 5, operation: 'cut' })

    // the axis given from below still enters at the end nearest the point
    const r = await ok<Out>('slicerx_geom_hole', { design: d, center: [15, 10, 5], axis: [0, 0, -1], diameter_mm: 3.4, counterbore: { diameter_mm: 6.5, depth_mm: 3 }, label: 'M3 counterbore' })
    expect(r.part).toBe(0)
    expect(r.before).toEqual({ center: [15, 10, 5], axis: [0, 0, 1], diameterMm: 6, depthMm: 5, kind: 'through' })
    expect(r.after).toEqual({ center: [15, 10, 5], axis: [0, 0, 1], diameterMm: 3.4, depthMm: 5, kind: 'through', head: 'counterbore', counterbore: { diameterMm: 6.5, depthMm: 3 } })
    expect(r.steps).toBe(3)
    expect(r.lastStep).toMatchObject({ name: 'M3 counterbore', op: 'hole.apply', state: 'done', value: { label: 'Diameter', value: 3.4 } })
    const removed = Math.PI * (1.7 ** 2 * 2 + 3.25 ** 2 * 3)
    expect(Math.abs(r.volumeMm3 - (3000 - removed))).toBeLessThan(0.01 * removed)

    // the step keeps the hole as found and the spec, as the hole tool writes them, so an edit replays it
    const edited = await ok<{ volumeMm3: number }>('slicerx_design_edit_step', { design: d, step: 3, value: 4 })
    const wider = Math.PI * (2 ** 2 * 2 + 3.25 ** 2 * 3)
    expect(Math.abs(edited.volumeMm3 - (3000 - wider))).toBeLessThan(0.01 * wider)
    const shaft = await ok<{ measurement: { diameterMm?: number; radiusMm?: number } }>('slicerx_geom_measure', { design: d, a: { at: [17, 10, 1], normal: [-1, 0, 0] } })
    expect(shaft.measurement.diameterMm ?? (shaft.measurement.radiusMm ?? 0) * 2).toBeCloseTo(4, 1)
  }, 60_000)

  it('picks a blind hole by a point on its wall and makes it narrower and shallower', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Block' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [10, 10] }, distance_mm: 20 })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 6 }, frame: top(20), placement: { center: [10, 10] }, distance_mm: 8, operation: 'cut' })

    const r = await ok<Out>('slicerx_geom_hole', { design: d, face: { at: [13, 10, 16], normal: [-1, 0, 0] }, diameter_mm: 5, depth_mm: 4 })
    expect(r.before).toEqual({ center: [10, 10, 20], axis: [0, 0, 1], diameterMm: 6, depthMm: 8, kind: 'blind' })
    expect(r.after).toEqual({ center: [10, 10, 20], axis: [0, 0, 1], diameterMm: 5, depthMm: 4, kind: 'blind', head: 'none' })
    expect(r.lastStep).toMatchObject({ name: 'Hole 5 mm', op: 'hole.apply', state: 'done' })
    const hole = Math.PI * 2.5 ** 2 * 4
    expect(Math.abs(r.volumeMm3 - (8000 - hole))).toBeLessThan(0.01 * hole)
  }, 60_000)

  it('says what face is there when a pick finds no hole, and leaves the design as it was', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Plain' })).output.design
    await h.call('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 5 })

    const axis = await h.call('slicerx_geom_hole', { design: d, center: [5, 5, 5], axis: [0, 0, 1], diameter_mm: 4 })
    expect(axis.isError).toBe(true)
    expect(text(axis)).toMatch(/no round hole on that axis line; the nearest face to the point is a flat face/)
    const wall = await h.call('slicerx_geom_hole', { design: d, face: { at: [5, 5, 5], normal: [0, 0, 1] }, diameter_mm: 4 })
    expect(wall.isError).toBe(true)
    expect(text(wall)).toMatch(/no round hole there: the pick is on a flat face/)
    const nothing = await h.call('slicerx_geom_hole', { design: d, center: [5, 5, 5], axis: [0, 0, 1] })
    expect(text(nothing)).toMatch(/give what the hole becomes/)
    const both = await h.call('slicerx_geom_hole', { design: d, center: [5, 5, 5], axis: [0, 0, 1], face: { at: [5, 5, 5] }, diameter_mm: 4 })
    expect(text(both)).toMatch(/not both/)

    const steps = data<{ output: { steps: unknown[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps).toHaveLength(1)
  }, 60_000)
})
