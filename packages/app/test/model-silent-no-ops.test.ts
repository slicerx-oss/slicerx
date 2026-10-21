// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model tools that had nothing to do said nothing: a cut on the object's own top or bottom face, a hollow with a wall
// too thick for the object, and a named value added under a name already in use. Each now says so and changes nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { IDENTITY } from '@slicerx/cad-history'
import { setGeomProvider, toGeom, type GeomMesh } from '../src/geom/client'
import { cutSelected, hollowSelected } from '../src/plate/geom-ops'
import { boxMesh } from '../src/plate/mesh-ops'
import { addValue, setValue } from '../src/cad/value-ops'
import { get, set, type PlateEntry } from '../src/state/store'

const handle: MeshHandle = { id: 'h', name: 'cube', hash: 'h', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] }
const host = { loadParts: async () => handle }
const cube = (): MeshPart => ({ ...boxMesh(20, 20, 20), name: 'cube', slot: 1 })
const at = (x: number, y: number) => {
  const t = [...IDENTITY]
  t[12] = x
  t[13] = y
  return t
}
const entry = (): PlateEntry => ({ id: 'c', name: 'Cube', parts: [cube()], handle, colors: ['#ffffff'], transform: at(100, 100) })

beforeEach(() => set({ plate: [entry()], selection: 'c', selectedIds: ['c'], toast: null, namedValues: [] }))
afterEach(() => setGeomProvider(null))

describe('cut', () => {
  // the engine's answer for a plane on the top face: the whole cube below, nothing above (and the other way round)
  const onFace = (side: 'below' | 'above') => setGeomProvider({ call: async <R>(_op: string, req: unknown) => ({ [side]: (req as { mesh: GeomMesh }).mesh }) as R })

  for (const [side, keep] of [['below', 'below'], ['above', 'above'], ['below', 'both']] as const) {
    it(`says the plane does not cross the object when it lies on a face, keeping ${keep}`, async () => {
      onFace(side)
      const before = get().plate
      expect(await cutSelected(host, { axis: 'z', atMm: side === 'below' ? 20 : 0, keep })).toBe(0)
      expect(get().plate).toBe(before)
      expect(get().plate.map((e) => e.name)).toEqual(['Cube'])
      expect(get().toast).toMatchObject({ text: 'The plane does not cross the object. Pick a height inside it.', tone: 'warn' })
    })
  }

  it('still cuts when the plane crosses the object', async () => {
    const half = (z0: number, z1: number) => { const m = toGeom(boxMesh(20, 20, z1 - z0)); return { ...m, positions: m.positions.map((v, i) => (i % 3 === 2 ? v + z0 : v)) } }
    setGeomProvider({ call: async <R>() => ({ below: half(0, 8), above: half(8, 20) }) as R })
    expect(await cutSelected(host, { axis: 'z', atMm: 8, keep: 'below' })).toBe(1)
    expect(get().plate.map((e) => e.name)).toEqual(['Cube lower'])
  })
})

describe('hollow', () => {
  it('refuses a wall too thick for the object, records nothing and keeps the mesh', async () => {
    // what the engine answers for a 15 mm wall on a 20 mm cube: the same 12 triangles and nothing saved
    setGeomProvider({ call: async <R>(_op: string, req: unknown) => ({ mesh: (req as { mesh: GeomMesh }).mesh, report: { materialSavedPercent: 0 } }) as R })
    const before = get().plate[0]!
    await expect(hollowSelected(host, 15)).rejects.toThrow('A 15 mm wall is too thick to hollow this object, so nothing changed. Try a thinner wall.')
    expect(get().plate[0]).toBe(before)
    expect(get().plate[0]!.history).toBeUndefined()
  })
})

describe('named values', () => {
  it('Add refuses a name already in use and keeps its value', () => {
    addValue('wall', '2')
    expect(() => addValue('wall', '5')).toThrow('There is already a value named wall.')
    expect(get().namedValues).toEqual([{ name: 'wall', expr: '2' }])
  })
  it('a row still changes its own value', () => {
    addValue('wall', '2')
    setValue('wall', '5')
    expect(get().namedValues).toEqual([{ name: 'wall', expr: '5' }])
  })
})
