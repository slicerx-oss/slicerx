// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cut with Keep both: the two halves stand side by side on the bed, not one on top of the other at the same spot.
import { afterEach, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { IDENTITY } from '@slicerx/cad-history'
import { setGeomProvider } from '../src/geom/client'
import { cutSelected } from '../src/plate/geom-ops'
import { bounds } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const handle: MeshHandle = { id: 'h', name: 'cube', hash: 'h', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] }
const host = { loadParts: async () => handle }

// a closed box as the engine returns it, in bed coordinates
function box(min: number[], max: number[]) {
  const [x0, y0, z0] = min as [number, number, number]
  const [x1, y1, z1] = max as [number, number, number]
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { positions, indices }
}

const part = (): MeshPart => {
  const b = box([0, 0, 0], [20, 20, 20])
  return { name: 'cube', slot: 1, positions: new Float32Array(b.positions), indices: new Uint32Array(b.indices) }
}

const at = (x: number, y: number) => {
  const t = [...IDENTITY]
  t[12] = x
  t[13] = y
  return t
}

afterEach(() => setGeomProvider(null))

it('stands the halves of a cut side by side, clear of each other and of the other objects', async () => {
  setGeomProvider({ call: async <T>() => ({ below: box([100, 100, 0], [120, 120, 8]), above: box([100, 100, 8], [120, 120, 20]) }) as T })
  const cube: PlateEntry = { id: 'cube', name: 'Cube', parts: [part()], handle, colors: ['#ffffff'], transform: at(100, 100) }
  // something already stands just right of the cube
  const other: PlateEntry = { id: 'other', name: 'Other', parts: [part()], handle, colors: ['#ffffff'], transform: at(125, 100) }
  set({ plate: [cube, other], selection: cube.id, selectedIds: [cube.id] })
  expect(await cutSelected(host, { axis: 'z', atMm: 8, keep: 'both' })).toBe(2)
  const boxes = get().plate.map((e) => ({ id: e.name, b: bounds(e.parts, e.transform)! }))
  const lower = boxes.find((x) => x.id === 'Cube lower')!.b
  const upper = boxes.find((x) => x.id === 'Cube upper')!.b
  const rest = boxes.find((x) => x.id === 'Other')!.b
  // the lower half stays where the cube was, both stand on the bed
  expect(lower.min[0]).toBeCloseTo(100)
  expect(lower.min[2]).toBeCloseTo(0)
  expect(upper.min[2]).toBeCloseTo(0)
  const apart = (a: typeof lower, b: typeof lower) => a.max[0] <= b.min[0] || b.max[0] <= a.min[0] || a.max[1] <= b.min[1] || b.max[1] <= a.min[1]
  expect(apart(lower, upper)).toBe(true)
  expect(apart(upper, rest)).toBe(true)
  // beside it, on the same row
  expect((upper.min[1] + upper.max[1]) / 2).toBeCloseTo((lower.min[1] + lower.max[1]) / 2)
})
