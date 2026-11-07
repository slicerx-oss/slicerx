// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint from a texture and the crossing check's rebuild: whether the rebuild lands after the texture paint or while the
// engine is painting, every face of the rebuilt mesh ends up in the filament of the box it belongs to. Two boxes in one
// part cross each other, box A red and box B green in the texture's materials; the rebuild is the engine's own answer
// for them (sx-geom import.selfIntersections, perShell false). Runs the real geometry engine
// (packages/geom/wasm/pkg); skips without one, except on CI.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshPart } from '@slicerx/contracts'
import { decodeTree, leavesOf } from '@slicerx/viewport'
import { setGeomProvider, type GeomProvider } from '../src/geom/client'
import { history } from '../src/plate/history'
import { forgetTexture, paintOpenedFromTexture, textureRepaints, type TextureSource } from '../src/plate/texture-paint'
import { checkCrossings, type CrossingRunner, type Quiet } from '../src/state/import-auto'
import { get, set, type PlateEntry } from '../src/state/store'
import { liveEngine, wasmGeom } from './geom-engine'

type V3 = [number, number, number]

// Box A [0,20]^3 and box B [10,30]^3 in one part, and the rebuilt mesh without the crossings: every triangle has a new
// number, and the faces of each box inside the other are gone.
const before = {
  positions: [0, 0, 0, 20, 0, 0, 0, 20, 0, 20, 20, 0, 0, 0, 20, 20, 0, 20, 0, 20, 20, 20, 20, 20, 10, 10, 10, 30, 10, 10, 10, 30, 10, 30, 30, 10, 10, 10, 30, 30, 10, 30, 10, 30, 30, 30, 30, 30],
  indices: [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 8, 10, 11, 8, 11, 9, 12, 13, 15, 12, 15, 14, 8, 9, 13, 8, 13, 12, 10, 14, 15, 10, 15, 11, 8, 12, 14, 8, 14, 10, 9, 11, 15, 9, 15, 13],
}
const rebuilt = {
  positions: [0, 0, 0, 0, 0, 20, 10, 10, 20, 10, 10, 30, 0, 20, 0, 10, 20, 10, 10, 30, 10, 0, 20, 20, 10, 20, 20, 10, 30, 30, 20, 0, 0, 20, 10, 10, 30, 10, 10, 20, 0, 20, 20, 10, 20, 30, 10, 30, 20, 20, 0, 20, 20, 10, 30, 30, 10, 30, 30, 30],
  indices: [0, 1, 7, 0, 13, 1, 0, 7, 4, 0, 4, 16, 0, 10, 13, 0, 16, 10, 7, 1, 2, 2, 1, 13, 3, 8, 2, 2, 14, 3, 5, 4, 7, 16, 4, 5, 5, 8, 6, 6, 17, 5, 8, 7, 2, 7, 8, 5, 8, 3, 9, 6, 8, 9, 13, 10, 11, 11, 10, 16, 12, 14, 11, 11, 17, 12, 13, 14, 2, 14, 13, 11, 3, 14, 15, 14, 12, 15, 17, 16, 5, 16, 17, 11, 17, 6, 18, 12, 17, 18, 3, 19, 9, 6, 9, 19, 3, 15, 19, 12, 19, 15, 6, 19, 18, 12, 18, 19],
}

const RED = '#e6141e'
const GREEN = '#14c828'

/** The same two boxes as an OBJ, box A in a red material and box B in a green one. */
function source(): TextureSource {
  const p = before.positions
  const v = Array.from({ length: p.length / 3 }, (_, i) => `v ${p[i * 3]} ${p[i * 3 + 1]} ${p[i * 3 + 2]}`)
  const f = (from: number) => Array.from({ length: 12 }, (_, t) => `f ${before.indices.slice((from + t) * 3, (from + t) * 3 + 3).map((i) => i + 1).join(' ')}`)
  const obj = ['mtllib boxes.mtl', ...v, 'usemtl red', ...f(0), 'usemtl green', ...f(12), ''].join('\n')
  const mtl = 'newmtl red\nKd 0.902 0.078 0.118\nnewmtl green\nKd 0.078 0.784 0.157\n'
  const enc = new TextEncoder()
  return { kind: 'obj', name: 'boxes.obj', obj: enc.encode(obj), files: { 'boxes.mtl': enc.encode(mtl) } }
}

const part = (): MeshPart => ({ name: 'boxes', slot: 1, positions: new Float32Array(before.positions), indices: new Uint32Array(before.indices) })
const entry = (p: MeshPart): PlateEntry => ({ id: 'o', name: 'o', handle: { id: 'o#0', hash: 'o', name: 'o', triangles: 24, bboxMm: [30, 30, 30], openEdges: 0, parts: [{ name: 'boxes', slot: 1, triangles: 24 }] }, parts: [p], colors: ['#fff'], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as PlateEntry
const host = { slicer: { loadParts: async (name: string) => ({ id: `${name}#1`, name, parts: [{ name: 'boxes', slot: 1, triangles: 36 }], triangles: 36, bboxMm: [30, 30, 30], hash: name, openEdges: 0 }), release: () => undefined } } as unknown as Host
const quiet: Quiet = { wait: async () => undefined, onBusy: () => () => undefined }
const cross: CrossingRunner = async () => ({ crossing: true, mesh: rebuilt })

function plain(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, plain(e)]))
  return v
}

/**
 * Every face of the object's mesh in the filament of its box: B's faces are the ones reaching past 20 mm, the rest are
 * A's (the rebuilt mesh keeps no face inside both). Answers the faces in the wrong filament.
 */
function wrongFaces(e: PlateEntry): string[] {
  const p = e.parts[0]!
  const own = e.slotOverrides?.[p.name] ?? p.slot
  const texts = e.paint?.[0]?.color ?? {}
  const wrong: string[] = []
  for (let t = 0; t < p.indices.length / 3; t++) {
    const corner = (k: number): V3 => {
      const i = p.indices[t * 3 + k]! * 3
      return [p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!]
    }
    const tri = [corner(0), corner(1), corner(2)] as [V3, V3, V3]
    const mid = [0, 1, 2].map((k) => (tri[0][k]! + tri[1][k]! + tri[2][k]!) / 3)
    const want = mid.some((c) => c > 20 + 1e-6) ? 2 : 1
    const text = texts[t]
    const got = text ? [...new Set(leavesOf(tri, decodeTree(text)!).map((l) => l.state || own))] : [own]
    if (got.length !== 1 || got[0] !== want) wrong.push(`${t} ${mid.map((c) => c.toFixed(1)).join(',')}: ${got.join('/')} for ${want}`)
  }
  return wrong
}

describe.skipIf(!liveEngine)('paint from a texture and the crossing rebuild', () => {
  let wasm: GeomProvider
  beforeAll(async () => {
    const w = await wasmGeom()
    wasm = { call: (op, request) => w.call(op, plain(request)) }
    setGeomProvider(wasm)
  })
  afterAll(() => setGeomProvider(null))
  beforeEach(() => {
    forgetTexture('o')
    set({ plate: [], plates: [{ id: 'p', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p', printerSlots: [], fileSlotColors: [], toast: null, openNote: null, slotSetup: { 1: { type: 'PLA', brand: '', color: RED }, 2: { type: 'PLA', brand: '', color: GREEN } } })
    history().clear()
    setGeomProvider(wasm)
  })

  it('paints the boxes in their own filaments before any rebuild', async () => {
    set({ plate: [entry(part())] })
    expect(await paintOpenedFromTexture(['o'], source())).toEqual([1, 2])
    expect(wrongFaces(get().plate[0]!)).toEqual([])
  })

  it('paints the rebuilt mesh again when the rebuild lands after the texture paint', async () => {
    set({ plate: [entry(part())] })
    await paintOpenedFromTexture(['o'], source())
    expect(await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, undefined, quiet)).toEqual({ fixed: 1, left: 0 })
    await textureRepaints()
    const o = get().plate[0]!
    expect(o.parts[0]!.indices.length).toBe(rebuilt.indices.length)
    expect(wrongFaces(o)).toEqual([])
  })

  it('paints the rebuilt mesh when the rebuild lands while the engine paints', async () => {
    set({ plate: [entry(part())] })
    let rebuiltOnce = false
    setGeomProvider({
      call: async (op, request) => {
        if (op === 'paint.texture' && !rebuiltOnce) {
          rebuiltOnce = true
          // the crossing check swaps the part in while this answer is on its way
          await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, undefined, quiet)
        }
        return wasm.call(op, request)
      },
    })
    expect(await paintOpenedFromTexture(['o'], source())).toEqual([1, 2])
    await textureRepaints()
    const o = get().plate[0]!
    expect(o.parts[0]!.indices.length).toBe(rebuilt.indices.length)
    expect(wrongFaces(o)).toEqual([])
  })
})
