// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A binary STL shows on the plate from its own triangles before the engine's import, which keeps that object when it
// changed nothing and puts its own result in its place when it did (a repair, a unit, loose bodies).
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshPart } from '@slicerx/contracts'
import type { AutoImport } from '../src/geom/cad'
import { isBinaryStl, sameMesh, scanStl } from '../src/export/stl-scan'
import { addAutoImport } from '../src/state/import-auto'
import { bounds, decompose } from '../src/plate/transform'
import { get, set } from '../src/state/store'

/** A 10 mm cube as a binary STL, its corners written once per triangle as STL does. */
const CORNERS = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]
const TRIS = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]

function stl(corners = CORNERS, tris = TRIS): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const v = new DataView(buf)
  v.setUint32(80, tris.length, true)
  tris.forEach((t, i) => t.forEach((c, k) => corners[c]!.forEach((x, a) => v.setFloat32(84 + i * 50 + 12 + k * 12 + a * 4, x, true))))
  return buf
}

/** The engine's answer for a mesh: one object of one part, in millimeters, unless told otherwise. */
function answer(mesh: { positions: number[]; indices: number[] }, over: { scale?: number; bodies?: number } = {}): AutoImport {
  const objects = Array.from({ length: over.bodies ?? 1 }, () => ({ name: 'cube.stl', parts: [{ name: 'cube.stl', slot: 1, color: null, mesh, watertight: true }], repair: {} as never }))
  return {
    name: 'cube.stl',
    format: 'stl',
    objects,
    unit: { unit: over.scale ? 'inch' : 'millimeter', scale: over.scale ?? 1, confidence: 'high', autoApply: Boolean(over.scale), reason: '', sizeBefore: [10, 10, 10], sizeAfter: [254, 254, 254] },
    summary: [],
    warnings: [],
    slotColors: [],
  } as AutoImport
}

const asPlain = (p: { positions: Float32Array; indices: Uint32Array }) => ({ positions: [...p.positions], indices: [...p.indices] })

function counting() {
  const loaded: string[] = []
  const released: string[] = []
  const host = { slicer: { loadParts: async (name: string, parts: MeshPart[]) => (loaded.push(name), { id: `${name}#${loaded.length}`, name, parts: [], triangles: parts[0]?.indices.length ?? 0 }), release: (id: string) => released.push(id) } } as unknown as Host
  return { host, loaded, released }
}

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], toast: null }))

describe('reading a binary STL', () => {
  it('welds the corners that are the same point, in the order they first appear', () => {
    const m = scanStl(new Uint8Array(stl()))!
    expect(m.positions.length / 3).toBe(8)
    expect(m.indices.length).toBe(36)
    expect([...m.positions.slice(0, 9)]).toEqual([0, 0, 0, 10, 10, 0, 10, 0, 0])
    expect([...m.indices.slice(0, 6)]).toEqual([0, 1, 2, 0, 3, 1])
  })

  it('takes -0 as the same point as 0, and refuses a corner that is not a number', () => {
    const minus = CORNERS.map((c) => c.map((x) => (x === 0 ? -0 : x)))
    expect(scanStl(new Uint8Array(stl([...CORNERS, ...minus], [...TRIS, ...TRIS.map((t) => t.map((c) => c + 8))])))!.positions.length / 3).toBe(8)
    expect(scanStl(new Uint8Array(stl(CORNERS.map((c, i) => (i === 3 ? [Number.NaN, 0, 0] : c)))))).toBeNull()
  })

  it('drops a triangle whose corners collapsed, and keeps the first corner\'s value of a point, as the engine does', () => {
    // A cube with -0 for its first corner, plus a triangle with two corners at one point and one with all three.
    const corners = [[-0, 0, 0], ...CORNERS.slice(1)]
    const m = scanStl(new Uint8Array(stl(corners, [...TRIS, [1, 1, 2], [6, 6, 6]])))!
    expect(m.indices.length).toBe(36)
    expect(m.positions.length / 3).toBe(8)
    expect(Object.is(m.positions[0], -0)).toBe(true)
  })

  it('leaves an ASCII STL to the engine', () => {
    const text = new TextEncoder().encode('solid cube\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid cube\n')
    expect(isBinaryStl(text)).toBe(false)
    expect(scanStl(text)).toBeNull()
  })

  it('compares two meshes value for value', () => {
    const a = scanStl(new Uint8Array(stl()))!
    expect(sameMesh(a, asPlain(a))).toBe(true)
    expect(sameMesh(a, { ...asPlain(a), indices: [...a.indices].reverse() })).toBe(false)
  })
})

describe('opening a binary STL', () => {
  it('shows the model before the engine answers, and keeps it when the engine changed nothing', async () => {
    const { host, loaded, released } = counting()
    let answerNow: (r: AutoImport) => void = () => undefined
    const engine = new Promise<AutoImport>((r) => (answerNow = r))
    const open = addAutoImport(host, 'cube.stl', stl(), () => engine)
    await new Promise((r) => setTimeout(r, 0))
    const shown = get().plate
    expect(shown).toHaveLength(1)
    expect(bounds(shown[0]!.parts, shown[0]!.transform)!.min[2]).toBeCloseTo(0)
    answerNow(answer(asPlain(scanStl(new Uint8Array(stl()))!)))
    const ids = await open
    expect(ids).toEqual([shown[0]!.id])
    expect(get().plate[0]).toBe(shown[0])
    expect(loaded).toHaveLength(1)
    expect(released).toEqual([])
  })

  it("puts the engine's result in its place when the engine changed the mesh", async () => {
    const { host, loaded, released } = counting()
    const repaired = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }
    const ids = await addAutoImport(host, 'cube.stl', stl(), async () => answer(repaired))
    expect(get().plate).toHaveLength(1)
    expect(get().plate[0]!.id).toBe(ids[0])
    expect([...get().plate[0]!.parts[0]!.indices]).toEqual(repaired.indices)
    expect(loaded).toHaveLength(2)
    expect(released).toEqual(['cube.stl#1'])
  })

  it('scales a file the engine reads as inches, and splits loose bodies into objects', async () => {
    const same = asPlain(scanStl(new Uint8Array(stl()))!)
    await addAutoImport(counting().host, 'cube.stl', stl(), async () => answer(same, { scale: 25.4 }))
    expect(get().plate).toHaveLength(1)
    expect(decompose(get().plate[0]!.transform).scale[0]).toBeCloseTo(25.4)
    set({ plate: [] })
    await addAutoImport(counting().host, 'cube.stl', stl(), async () => answer(same, { bodies: 2 }))
    expect(get().plate).toHaveLength(2)
  })

  it('keeps the model as it was read when the engine cannot import it', async () => {
    const ids = await addAutoImport(counting().host, 'cube.stl', stl(), async () => {
      throw new Error('no engine')
    })
    expect(get().plate.map((p) => p.id)).toEqual(ids)
    expect(get().toast?.text).toBe('Added cube.stl')
  })
})
