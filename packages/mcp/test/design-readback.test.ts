// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client shells a design into a tray as a step, then reads it back as it is now and as it was at an earlier step:
// info for volume and closure, measure for the floor's thickness.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('design-readback-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

describe('a design read back at any step', () => {
  it('shells a box into a tray as a step, and measures and checks it now and before', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Tray' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 10 })
    const tray = await ok<{ steps: number; volumeMm3: number; lastStep: { name: string } }>('slicerx_geom_shell', { design: d, open: [{ at: [15, 10, 10], normal: [0, 0, 1] }], wall_mm: 2 })
    expect(tray.steps).toBe(2)
    expect(tray.lastStep.name).toBe('Shell, 2 mm walls, 1 open face')
    expect(tray.volumeMm3).toBeCloseTo(6000 - 26 * 16 * 8, 1)

    const now = await ok<{ parts: { watertight: boolean; volumeMm3: number }[] }>('slicerx_geom_info', { design: d })
    expect(now.parts[0]?.watertight).toBe(true)
    expect(now.parts[0]?.volumeMm3).toBeCloseTo(tray.volumeMm3, 1)
    const before = await ok<{ parts: { volumeMm3: number }[] }>('slicerx_geom_info', { design: d, step: 'Rectangle extrude 10 mm' })
    expect(before.parts[0]?.volumeMm3).toBeCloseTo(6000, 1)

    // The floor: its top inside the tray and the bottom of the box.
    const floor = await ok<{ measurement: { distanceMm: number } }>('slicerx_geom_measure', { design: d, a: { at: [15, 10, 2], normal: [0, 0, 1] }, b: { at: [15, 10, 0], normal: [0, 0, -1] } })
    expect(floor.measurement.distanceMm).toBeCloseTo(2, 3)
    const solid = await ok<{ measurement: { distanceMm: number } }>('slicerx_geom_measure', { design: d, step: 1, a: { at: [15, 10, 10], normal: [0, 0, 1] }, b: { at: [15, 10, 0], normal: [0, 0, -1] } })
    expect(solid.measurement.distanceMm).toBeCloseTo(10, 3)

    // The wall follows the top through an edit: a taller box keeps a 2 mm floor and an open top.
    const taller = await h.call('slicerx_design_edit_step', { design: d, step: 1, value: 14 })
    expect(taller.isError, text(taller)).toBeFalsy()
    expect(data<{ output: { volumeMm3: number } }>(taller).output.volumeMm3).toBeCloseTo(30 * 20 * 14 - 26 * 16 * 12, 1)
  }, 60_000)
})
