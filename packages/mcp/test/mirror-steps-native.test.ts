// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client builds a row of holes or bosses on one side of a part and mirrors the detail and its row to the other side
// in one call, naming both steps, on the real engine: on exact solids, where the mirror image goes to the kernel as a
// cut or join of its own, and on the mesh. Each mirrored detail is made once, so the part loses or gains exactly
// twice what the first side did.
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { GEOM_BUILD, built, connect, data, noKernel, text } from './helpers'

const bin = process.env['SLICERX_SX_GEOM_BIN']
// the exact case runs on an sx-geom with the exact kernel, the mesh case on any sx-geom
const why = noKernel(bin)
const mesh = built(bin, GEOM_BUILD)
afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
})

interface Summary {
  design: string
  exact: boolean
  volumeMm3: number
}

async function client() {
  const calls: string[] = []
  const native = geomEngine(bin!, 30_000)
  const h = await connect({ geomEngine: async (op, request) => {
    calls.push(op)
    return native(op, request)
  } })
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  return { h, ok, calls }
}

// a block 40 x 20 x 10 mm centered on the origin: its sides at y -10 and 10, its top at z 10
const block = { shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 10 }

it.skipIf(why !== null)(`mirrors a row of portholes and a row of bosses across the middle on exact solids, each copy on the kernel${why ? ` (skipped: ${why})` : ''}`, async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const { ok, calls } = await client()
  const d = (await ok('slicerx_design_new', { name: 'Hull', exact: true })).design
  const solid = await ok('slicerx_geom_extrude', { design: d, ...block })
  expect(solid.exact).toBe(true)
  expect(solid.volumeMm3).toBeCloseTo(8000, 3)

  // a porthole in the side at y -10 and a row of four, 5 mm apart
  await ok('slicerx_geom_hole', { design: d, part: 0, face: { at: [-10, -10, 5], normal: [0, -1, 0] }, diameter_mm: 1, depth_mm: 0.6 })
  const row = await ok('slicerx_geom_array', { design: d, steps: [2], spec: { kind: 'linear', count: 4, step: [5, 0, 0] } })
  const cut = solid.volumeMm3 - row.volumeMm3
  expect(cut).toBeGreaterThan(4 * 0.4)

  // the porthole and its row mirrored to the side at y 10, both steps named
  const before = calls.length
  const both = await ok('slicerx_geom_mirror', { design: d, steps: [2, 3], plane: { axis: 'y', at: 0 } })
  const sent = calls.slice(before)
  expect(sent).toContain('brep.extrude')
  expect(sent).not.toContain('shape.extrude')
  expect(both.exact).toBe(true)
  expect(solid.volumeMm3 - both.volumeMm3).toBeCloseTo(2 * cut, 3)

  // a boss on the top, 5 x 1.6 mm and 1 mm tall, off center, and a row of three, mirrored across the same middle
  const boss = await ok('slicerx_geom_extrude', { design: d, part: 0, shape: { type: 'slot', lengthMm: 5, widthMm: 1.6 }, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, placement: { center: [-10, -5] }, distance_mm: 1, operation: 'join' })
  const bosses = await ok('slicerx_geom_array', { design: d, steps: [5], spec: { kind: 'linear', count: 3, step: [8, 0, 0] } })
  const added = bosses.volumeMm3 - both.volumeMm3
  expect(added).toBeGreaterThan(boss.volumeMm3 - both.volumeMm3)
  const at = calls.length
  const pairs = await ok('slicerx_geom_mirror', { design: d, steps: [5, 6], plane: { axis: 'y', at: 0 } })
  expect(calls.slice(at)).not.toContain('shape.extrude')
  expect(pairs.volumeMm3 - both.volumeMm3).toBeCloseTo(2 * added, 3)
}, 60_000)

it.skipIf(!mesh)(`mirrors a row of bosses and a row of portholes across the middle on the mesh, each copy made once${mesh ? '' : ` (skipped: ${GEOM_BUILD})`}`, async () => {
  const { ok } = await client()
  const d = (await ok('slicerx_design_new', { name: 'Deck' })).design
  const solid = await ok('slicerx_geom_extrude', { design: d, ...block })
  expect(solid.exact).toBe(false)

  // a boss on the top and a row of three, mirrored: the mirror image of each is joined once, not a second time
  // inside the first
  await ok('slicerx_geom_extrude', { design: d, part: 0, shape: { type: 'slot', lengthMm: 5, widthMm: 1.6 }, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, placement: { center: [-10, -5] }, distance_mm: 1, operation: 'join' })
  const bosses = await ok('slicerx_geom_array', { design: d, steps: [2], spec: { kind: 'linear', count: 3, step: [8, 0, 0] } })
  const added = bosses.volumeMm3 - solid.volumeMm3
  expect(added).toBeGreaterThan(0)
  const pairs = await ok('slicerx_geom_mirror', { design: d, steps: [2, 3], plane: { axis: 'y', at: 0 } })
  expect(pairs.volumeMm3 - solid.volumeMm3).toBeCloseTo(2 * added, 2)

  // a window in the side and a row of four, mirrored to the other side
  await ok('slicerx_geom_extrude', { design: d, part: 0, shape: { type: 'rectangle', widthMm: 1.2, heightMm: 1 }, frame: { origin: [-10, -10, 5], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, distance_mm: 0.9, operation: 'cut' })
  const windows = await ok('slicerx_geom_array', { design: d, steps: [5], spec: { kind: 'linear', count: 4, step: [4, 0, 0] } })
  const cut = pairs.volumeMm3 - windows.volumeMm3
  expect(cut).toBeCloseTo(4 * 1.2 * 0.9, 2)
  const both = await ok('slicerx_geom_mirror', { design: d, steps: [5, 6], plane: { axis: 'y', at: 0 } })
  expect(pairs.volumeMm3 - both.volumeMm3).toBeCloseTo(2 * cut, 2)
}, 60_000)
