// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client asks geom.hole for a hole narrower than the nozzle: it is refused in the hole tool's own words, before the
// engine runs, and the design keeps its steps. The nozzle is the server's (the project's printer), 0.4 mm without one.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('design-hole-floor-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)
const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] })

describe('a hole too small to print', () => {
  it('is refused on a design with the smallest the nozzle prints, and the design keeps its steps', async () => {
    const h = await connect({ geomEngine: engine, nozzleMm: 0.6 })
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Plate' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 5 })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 6 }, frame: top(5), placement: { center: [15, 10] }, distance_mm: 5, operation: 'cut' })

    const small = await h.call('slicerx_geom_hole', { design: d, center: [15, 10, 5], axis: [0, 0, 1], diameter_mm: 0.3 })
    expect(small.isError).toBe(true)
    expect(text(small)).toContain('The diameter is too small to print with a 0.6 mm nozzle. The smallest is 0.6 mm.')

    // the nozzle itself is fine, and lands as the third step: the refusal added none
    const r = await ok<{ steps: number; after: { diameterMm: number } }>('slicerx_geom_hole', { design: d, center: [15, 10, 5], axis: [0, 0, 1], diameter_mm: 0.6 })
    expect(r.steps).toBe(3)
    expect(r.after.diameterMm).toBeCloseTo(0.6, 1)
  }, 60_000)

  it('is refused on a model file with a 0.4 mm nozzle when the server names none', async () => {
    const h = await connect({ geomEngine: engine })
    const r = await h.call('slicerx_geom_hole', { model: `${h.dir}/cube.stl`, center: [10, 10, 20], axis: [0, 0, 1], diameter_mm: 0.001 })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('The diameter is too small to print with a 0.4 mm nozzle. The smallest is 0.4 mm.')
  })
})
