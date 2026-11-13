// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A mesh part built into an exact design is added beside the exact part, and a client reads it back marked as a mesh
// part (`mesh: true`); joining it into the exact part stops on a design that must stay exact. A stand-in exact engine.
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { connect, data, text } from './helpers'

type R = Record<string, unknown>
const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }
const cube = (x: number) => ({ positions: [x, 0, 0, x + 4, 0, 0, x, 4, 0, x, 0, 4], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] })

async function engine(op: string, request: unknown) {
  const req = request as R
  if (op === 'brep.count') return { bodies: 0 }
  if (op === 'brep.tessellate') return { ...cube(0), faceIds: [0, 0, 0, 0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
  if (op.startsWith('brep.')) return { bodySmb: `${op.slice(5)}-${req['target'] ?? 'new'}`, touches: true }
  if (op === 'build') return { mesh: cube(40) }
  return { mesh: tri }
}

afterEach(() => { vi.unstubAllEnvs(); clearReplayCache() })

type Part = { index: number; name: string; mesh?: boolean }

it('adds a built mesh part beside the exact part and reads it back as a mesh part', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect({ geomEngine: engine })
  const made = await h.call('slicerx_design_new', { name: 'Ship', exact: true })
  expect(made.isError, text(made)).toBeFalsy()
  const design = data<{ output: { design: string } }>(made).output.design
  const hull = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, placement: { center: [10, 5] }, distance_mm: 5 })
  expect(hull.isError, text(hull)).toBeFalsy()
  // two solids make one mesh part, with no shape the kernel could make it as
  const built = await h.call('slicerx_geom_build', { design, name: 'Davit', solids: [{ type: 'box', min: [40, 0, 0], max: [44, 4, 4] }, { type: 'box', min: [44, 0, 0], max: [48, 4, 4] }] })
  expect(built.isError, text(built)).toBeFalsy()
  const rows = data<{ output: { exact: boolean; parts: Part[] } }>(await h.call('slicerx_design_steps', { design })).output
  expect(rows.exact).toBe(true)
  expect(rows.parts.map((p) => [p.name, p.mesh ?? false])).toEqual([['Body', false], ['Davit', true]])
  const joined = await h.call('slicerx_geom_boolean', { op: 'union', design, part: 0, with_parts: [1] })
  expect(joined.isError).toBe(true)
  expect(text(joined)).toContain('Exact replay does not support boolean for this part. The mesh path was not used.')
}, 30_000)
