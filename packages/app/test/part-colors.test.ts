// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An object's colors are per part (colors[i] is part i's), so split and merge carry each part's own color.
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { mergeSelected, splitSelectedToObjects, splitSelectedToParts } from '../src/plate/edit'
import { bake, boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string) => handle(name) }
const at = (x: number) => compose({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })

/** One part made of two boxes that do not touch, so it splits in two. */
function twoBoxes(name: string, slot: number): MeshPart {
  const a = bake(boxMesh(10, 10, 10), at(0))
  const b = bake(boxMesh(10, 10, 10), at(40))
  const n = a.positions.length / 3
  return { name, slot, positions: Float32Array.from([...a.positions, ...b.positions]), indices: Uint32Array.from([...a.indices, ...[...b.indices].map((i) => i + n)]) }
}

const box = (name: string, slot: number, x = 0): MeshPart => ({ ...bake(boxMesh(10, 10, 10), at(x)), name, slot })
const entry = (id: string, parts: MeshPart[], colors: string[], x = 100): PlateEntry => ({ id, name: id, handle: handle(id), parts, colors, transform: compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

beforeEach(() => set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: null, selectedIds: [], toast: null }))

describe('per-part colors', () => {
  // Part 0 prints in slot 2 and part 1 in slot 1: indexing the colors by slot would swap them.
  const RED = '#aa0000'
  const GREEN = '#00bb00'

  it('stay with their pieces when a part splits into parts', async () => {
    set({ plate: [entry('a', [twoBoxes('body', 2), box('cap', 1, 80)], [RED, GREEN])], selection: 'a', selectedIds: ['a'] })
    expect(await splitSelectedToParts(loader)).toBe(3)
    const o = get().plate[0]!
    expect(o.parts.map((p) => p.slot)).toEqual([2, 2, 1])
    expect(o.colors).toEqual([RED, RED, GREEN])
  })

  it('stay with their pieces when an object splits into objects', async () => {
    set({ plate: [entry('a', [twoBoxes('body', 2), box('cap', 1, 80)], [RED, GREEN])], selection: 'a', selectedIds: ['a'] })
    expect(await splitSelectedToObjects(loader)).toBe(3)
    expect(get().plate.map((o) => [o.parts[0]!.slot, o.colors[0]])).toEqual([[2, RED], [2, RED], [1, GREEN]])
  })

  it('stay with their parts when objects merge', async () => {
    const one = entry('one', [box('a', 1), box('c', 3, 20)], ['#111111', '#333333'], 60)
    const two = entry('two', [box('b', 2)], ['#222222'], 160)
    set({ plate: [one, two], selection: 'one', selectedIds: ['one', 'two'] })
    expect(await mergeSelected(loader)).toBe(true)
    const merged = get().plate[0]!
    expect(merged.parts.map((p) => p.slot)).toEqual([1, 3, 2])
    expect(merged.colors).toEqual(['#111111', '#333333', '#222222'])
  })

  it('give no part a color from another slot after a merge', async () => {
    set({ plate: [entry('one', [box('a', 2)], [RED], 60), entry('two', [box('b', 1)], [GREEN], 160)], selection: 'one', selectedIds: ['one', 'two'] })
    await mergeSelected(loader)
    expect(get().plate[0]!.colors).toEqual([RED, GREEN])
  })
})
