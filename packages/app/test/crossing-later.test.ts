// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The check for faces that cross each other runs after the model shows: a part small enough to rebuild takes the place
// of the one on the plate, a bigger one gets a note, and a part changed meanwhile is left alone.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshPart } from '@slicerx/contracts'
import { checkCrossings, type CrossingRunner } from '../src/state/import-auto'
import { get, set, type PlateEntry } from '../src/state/store'

const part = (n: number): MeshPart => ({ name: `p${n}`, slot: 1, positions: new Float32Array([0, 0, 0, n, 0, 0, 0, n, 0, 0, 0, n]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) })
const entry = (id: string, parts: MeshPart[]): PlateEntry => ({ id, name: id, handle: { id: `${id}#0`, hash: id, name: id, triangles: 4, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts, colors: parts.map(() => '#fff'), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as PlateEntry

function counting() {
  const loaded: string[] = []
  const released: string[] = []
  const host = { slicer: { loadParts: async (name: string) => (loaded.push(name), { id: `${name}#${loaded.length}`, name, parts: [], triangles: 4, bboxMm: [1, 1, 1], hash: name, openEdges: 0 }), release: (id: string) => released.push(id) } } as unknown as Host
  return { host, loaded, released }
}

const rebuilt = { positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] }

beforeEach(() => set({ plate: [], toast: null }))

describe('the crossing check after the model shows', () => {
  it('puts a rebuilt part in place of a crossing one, and says so', async () => {
    const [a, b] = [part(1), part(3)]
    set({ plate: [entry('o', [a, b])] })
    const { host, loaded, released } = counting()
    const asked: boolean[] = []
    const cross: CrossingRunner = async (p, perShell) => (asked.push(perShell), p === b ? { crossing: true, mesh: rebuilt } : { crossing: false })
    expect(await checkCrossings(host, 'm.stl', [{ id: 'o', perShell: true }], cross)).toEqual({ fixed: 1, left: 0 })
    const o = get().plate[0]!
    expect(o.parts[0]).toBe(a)
    expect([...o.parts[1]!.positions]).toEqual(rebuilt.positions)
    expect(o.handle.id).toBe('o#1')
    expect(loaded).toEqual(['o'])
    expect(released).toEqual(['o#0'])
    expect(asked).toEqual([true, true])
    expect(get().toast?.text).toBe('m.stl: Repaired: fixed self-intersections in 1 part.')
  })

  it('notes a crossing part too big to rebuild and leaves it', async () => {
    const a = part(1)
    set({ plate: [entry('o', [a])] })
    expect(await checkCrossings(counting().host, 'm.stl', [{ id: 'o', perShell: false }], async () => ({ crossing: true }))).toEqual({ fixed: 0, left: 1 })
    expect(get().plate[0]!.parts[0]).toBe(a)
    expect(get().toast?.text).toBe('m.stl: 1 part still crosses itself (too large to rebuild during import).')
    expect(get().toast?.tone).toBe('warn')
  })

  it('leaves a part that changed while it was checked, and an object that went', async () => {
    const a = part(1)
    set({ plate: [entry('o', [a]), entry('gone', [part(2)])] })
    const { host, loaded } = counting()
    const cross: CrossingRunner = async () => {
      // The person edits the object, and removes the other one, while the check runs.
      set((s) => ({ plate: s.plate.filter((p) => p.id !== 'gone').map((p) => (p.id === 'o' ? { ...p, parts: [part(5)] } : p)) }))
      return { crossing: true, mesh: rebuilt }
    }
    expect(await checkCrossings(host, 'm.stl', [{ id: 'o', perShell: true }, { id: 'gone', perShell: true }], cross)).toEqual({ fixed: 0, left: 0 })
    expect([...get().plate[0]!.parts[0]!.positions]).toEqual([...part(5).positions])
    expect(loaded).toEqual([])
    expect(get().toast).toBeNull()
  })
})
