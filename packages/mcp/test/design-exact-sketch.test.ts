// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sketch extruded in a design that must stay exact: loops that cross are refused with the sketch's own sentence, as
// on a mesh design, never with "not supported", and a sketch with nothing wrong goes to the kernel. A stand-in engine
// whose sketch check answers as sx-geom's does.
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { connect, data, text } from './helpers'

type R = Record<string, unknown>
const CROSS = 'Loop 2 crosses loop 1 (segment 1 of loop 2 meets segment 2 of loop 1).'
const cube = (x: number) => ({ positions: [x, 0, 0, x + 4, 0, 0, x, 4, 0, x, 0, 4], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] })
const square = { points: [[0, 0], [10, 0], [10, 10], [0, 10]] }

const sent: string[] = []
async function engine(op: string, request: unknown) {
  const req = request as R
  sent.push(op)
  // two loops are the crossing sketch, one is the square; a mesh extrude has them in its shape
  const loops = req['loops'] ?? (req['shape'] as R | undefined)?.['loops']
  const crossing = Array.isArray(loops) && loops.length === 2
  if (op === 'sketch.curves' && crossing) throw new Error(`sketch: ${CROSS}`)
  if (op === 'sketch.curves') return [{ outer: { points: square.points }, holes: [] }]
  if (op === 'sketch.check') return { issues: crossing ? [{ kind: 'loopsCross', message: CROSS }] : [], polygons: [] }
  if (op === 'shape.extrude' && crossing) throw new Error(`sketch: ${CROSS}`)
  if (op === 'brep.count') return { bodies: 0 }
  if (op === 'brep.tessellate') return { ...cube(0), faceIds: [0, 0, 0, 0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
  if (op.startsWith('brep.')) return { bodySmb: `${op.slice(5)}-new`, touches: true }
  return { mesh: cube(0) }
}

afterEach(() => { vi.unstubAllEnvs(); clearReplayCache(); sent.length = 0 })

it('refuses crossing loops with what is wrong, on an exact design as on a mesh one', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect({ geomEngine: engine })
  const crossing = { type: 'sketch', loops: [square, { type: 'circle', center: [10, 5], diameterMm: 4 }] }
  for (const exact of [true, false]) {
    const made = await h.call('slicerx_design_new', { name: 'Plate', exact })
    expect(made.isError, text(made)).toBeFalsy()
    const design = data<{ output: { design: string; exact: boolean } }>(made).output
    expect(design.exact).toBe(exact)
    const r = await h.call('slicerx_geom_extrude', { design: design.design, shape: crossing, distance_mm: 5 })
    expect(r.isError, text(r)).toBe(true)
    expect(text(r)).toContain(CROSS)
    expect(text(r)).not.toContain('does not support')
  }
  // a square goes to the kernel on the exact design
  const made = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Plate', exact: true })).output
  sent.length = 0
  const ok = await h.call('slicerx_geom_extrude', { design: made.design, shape: { type: 'sketch', loops: [square] }, distance_mm: 5 })
  expect(ok.isError, text(ok)).toBeFalsy()
  expect(sent).toContain('brep.extrude')
}, 30_000)
