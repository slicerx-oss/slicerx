// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which face keys a join on exact solids clears, read back through slicerx_geom_faces on the real engine. Faces in
// one plane that meet can become one face, so the join clears their keys and a reference to them asks for repair.
// Faces in one plane that stay apart can't, so they keep their keys and the step that made them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { connect, data, noKernel, text } from './helpers'

const bin = process.env['SLICERX_SX_GEOM_BIN']
const why = noKernel(bin)
afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
})

type V3 = [number, number, number]
interface Face {
  normal: V3
  center: V3
  key?: number
  from?: number
  madeBy: string
}

async function wall() {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect({ geomEngine: geomEngine(bin!, 30_000) })
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(`slicerx_${name}`, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const design = (await ok<{ design: string }>('design_new', { name: 'Wall', exact: true })).design
  // a wall 30 by 10, 10 tall: x -15 to 15, y -5 to 5
  await ok('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, distance_mm: 10 })
  // a w by h rectangle centered at (x, 0), extruded up by `distance` from height z and joined on
  const join = (w: number, h: number, x: number, z: number, distance: number) =>
    ok('geom_extrude', { design, part: 0, operation: 'join', shape: { type: 'rectangle', widthMm: w, heightMm: h }, frame: { origin: [0, 0, z], normal: [0, 0, 1] }, placement: { center: [x, 0] }, distance_mm: distance })
  /** The design's side faces (facing along x or y). */
  const sides = async () =>
    (await ok<{ faces: Face[] }>('geom_faces', { design, limit: 500 })).faces.filter((f) => Math.abs(f.normal[0]) > 0.99 || Math.abs(f.normal[1]) > 0.99)
  return { join, sides }
}

describe('the face keys a join clears, on exact solids', () => {
  const skip = why !== null
  const because = skip ? ` (skipped: ${why})` : ''

  it.skipIf(skip)(`a wall keeps the keys of its sides when a part joined above it lies in the same planes without touching them${because}`, async () => {
    const c = await wall()
    // a post on the wall, then a rim on the post 3 mm above the wall, with its four sides in the planes of the wall's
    await c.join(6, 4, 0, 10, 3)
    await c.join(30, 10, 0, 13, 2)
    const faces = await c.sides()
    const walls = faces.filter((f) => f.center[2] < 10)
    const rims = faces.filter((f) => f.center[2] > 13)
    expect(walls).toHaveLength(4)
    expect(rims).toHaveLength(4)
    for (const w of walls) {
      expect(w.key).toBeGreaterThan(0)
      expect(w.madeBy).toBe('Rectangle extrude 10 mm')
    }
    for (const r of rims) {
      expect(r.key).toBeGreaterThan(0)
      expect(r.madeBy).toBe('Rectangle extrude 2 mm')
    }
    expect(new Set([...walls, ...rims].map((f) => f.key)).size).toBe(8)
  })

  it.skipIf(skip)(`a join still clears the keys of faces in one plane that meet${because}`, async () => {
    const c = await wall()
    const facing = async () => (await c.sides()).filter((f) => Math.abs(f.normal[1]) > 0.99)
    const walls = await facing()
    expect(walls).toHaveLength(2)
    // a block 10 by 10, 6 tall, against the wall's end at x 15: its front and back meet the wall's, and the kernel
    // merges each pair into one face
    await c.join(10, 10, 20, 0, 6)
    const fronts = await facing()
    expect(fronts).toHaveLength(2)
    for (const f of fronts) {
      // the join cleared the key; the merged face came from the wall's side and names the wall's step
      const side = walls.find((w) => w.normal[1] === f.normal[1])!
      expect(f.key).toBeUndefined()
      expect(f.from).toBe(side.key)
      expect(f.madeBy).toBe('Rectangle extrude 10 mm')
    }
  })
})
