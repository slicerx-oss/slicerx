// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What made a face with no key of its own, read back through slicerx_geom_faces on the real engine. On exact solids a
// join clears the keys of the faces that lie flat with a face of the joined shape and meet it: a wall block's long
// sides lose theirs to a rim joined on top whose sides are in the same planes. On the mesh a subtract that
// splits a face leaves its pieces without a key. Either way the face says which face it came from (`from`), and the
// step that made that face is its maker, while a reference by key still asks for repair.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { GEOM_BUILD, built, connect, data, noKernel, text } from './helpers'

const bin = process.env['SLICERX_SX_GEOM_BIN']
const mesh = built(bin, GEOM_BUILD)
const why = noKernel(bin)
afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
})

type V3 = [number, number, number]
interface Face {
  normal: V3
  center: V3
  areaMm2: number
  key?: number
  from?: number
  madeBy: string
}

async function client() {
  const h = await connect({ geomEngine: geomEngine(bin!, 30_000) })
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(`slicerx_${name}`, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  /** The flat faces of the design that face along y, above the box (z over 10). */
  const sides = async (design: string) => (await ok<{ faces: Face[] }>('geom_faces', { design, limit: 500 })).faces.filter((f) => Math.abs(f.normal[1]) > 0.99 && f.center[2] > 10.01)
  return { ok, sides }
}

type Client = Awaited<ReturnType<typeof client>>

const start = async (c: Client, exact: boolean) => {
  if (exact) vi.stubEnv('SX_BREP_DEV', '1')
  const d = (await c.ok<{ design: string }>('design_new', { name: 'Block', ...(exact ? { exact: true } : {}) })).design
  await c.ok('geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 10 })
  return d
}
// a w by h rectangle extruded up by `distance` from height z, joined on
const block = (design: string, w: number, h: number, z: number, distance: number) => ({ design, part: 0, operation: 'join', shape: { type: 'rectangle', widthMm: w, heightMm: h }, frame: { origin: [0, 0, z], normal: [0, 0, 1] }, distance_mm: distance })

// a 30 by 10 wall block 4 tall on the box, a block 20 by 8 joined on top of it, then a rim 22 by 10: the rim's long
// sides lie in the planes of the wall block's, 3 mm above them, or on the wall block and meeting its sides
async function rimmed(c: Client, d: string, on = false) {
  await c.ok('geom_extrude', block(d, 30, 10, 10, 4))
  await c.ok('geom_extrude', block(d, 20, 8, 14, 3))
  await c.ok('geom_extrude', block(d, 22, 10, on ? 14 : 17, 0.8))
  return (await c.sides(d)).filter((f) => Math.abs(Math.abs(f.center[1]) - 5) < 0.01 && f.center[2] < 14)
}

// a 30 by 2 wall 8 tall on the box, then a 2 mm slot through its whole height at x -9: its long sides in two pieces
async function slotted(c: Client, d: string) {
  await c.ok('geom_extrude', block(d, 30, 2, 10, 8))
  await c.ok('geom_subtract', { design: d, part: 0, solids: [{ type: 'box', min: [-10, -2, 9], max: [-8, 2, 19] }] })
  return (await c.sides(d)).filter((f) => Math.abs(Math.abs(f.center[1]) - 1) < 0.01)
}

describe('what made a face with no key of its own, on exact solids', () => {
  const skip = why !== null
  const because = skip ? ` (skipped: ${why})` : ''

  it.skipIf(skip)(`a wall block's sides a rim on it lies flat with were made by the wall block's step${because}`, async () => {
    const c = await client()
    const walls = await rimmed(c, await start(c, true), true)
    expect(walls).toHaveLength(2)
    for (const w of walls) {
      // the join cleared the key, and the face still says which face it came from
      expect(w.key).toBeUndefined()
      expect(w.from).toBeGreaterThan(0)
      expect(w.madeBy).toBe('Rectangle extrude 4 mm')
    }
  })

  it.skipIf(skip)(`the pieces of a wall a subtract splits keep the wall's key, and its step made them${because}`, async () => {
    const c = await client()
    const pieces = await slotted(c, await start(c, true))
    expect(pieces).toHaveLength(4)
    expect(new Set(pieces.map((p) => p.key)).size).toBe(2)
    for (const p of pieces) {
      expect(p.from).toBeUndefined()
      expect(p.madeBy).toBe('Rectangle extrude 8 mm')
    }
  })
})

describe('what made a face with no key of its own, on the mesh', () => {
  const skip = !mesh
  const because = skip ? ` (skipped: ${GEOM_BUILD})` : ''

  it.skipIf(skip)(`the pieces of a wall a subtract splits were made by the wall's step${because}`, async () => {
    const c = await client()
    const pieces = await slotted(c, await start(c, false))
    expect(pieces).toHaveLength(4)
    for (const p of pieces) {
      expect(p.key).toBeUndefined()
      expect(p.from).toBeGreaterThan(0)
      expect(p.madeBy).toBe('Rectangle extrude 8 mm')
    }
    // the two pieces of each side came from that side
    expect(new Set(pieces.map((p) => p.from)).size).toBe(2)
  })

  it.skipIf(skip)(`a wall block's sides keep their keys under a rim higher up, made by the wall block's step${because}`, async () => {
    const c = await client()
    const walls = await rimmed(c, await start(c, false))
    expect(walls).toHaveLength(2)
    for (const w of walls) {
      expect(w.key).toBeGreaterThan(0)
      expect(w.madeBy).toBe('Rectangle extrude 4 mm')
    }
  })
})
