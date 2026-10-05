// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { parseBrimEars, readProject } from '../src/export/import3mf'
import { projectFiles, writeProject } from '../src/export/threemf'
import { addEar, autoGenerateEars, clearEars, defaultHeadDiameter, moveEar, removeEar, removeSelectedEars, resizeSelectedEars, selectEars, worldEars } from '../src/plate/brim-ears'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

function entry(id: string, at: [number, number, number] = [50, 60, 5]): PlateEntry {
  return { id, name: 'Box', handle: handle(id), parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: at, rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

describe('brim ears on the plate', () => {
  beforeEach(() => set({ plate: [entry('a')], selection: 'a' }))

  it('keeps the point in the object space, on the bed under the click', () => {
    expect(addEar('a', 58, 60)).toBe(true)
    const p = get().plate[0]!.brimPoints![0]!
    expect(p[0]).toBeCloseTo(8, 4)
    expect(p[1]).toBeCloseTo(0, 4)
    expect(p[2]).toBeCloseTo(-5.0001, 3)
    expect(p[3]).toBeCloseTo(defaultHeadDiameter() / 2, 4)
    expect(addEar('a', 58, 60)).toBe(false)
  })

  it('removes one ear, resizes them all, and clears', () => {
    addEar('a', 58, 60)
    addEar('a', 40, 60)
    removeEar('a', 0)
    expect(get().plate[0]!.brimPoints).toHaveLength(1)
    clearEars('a')
    expect(get().plate[0]!.brimPoints).toBeUndefined()
  })

  it('selects ears, resizes and removes only the selected ones', () => {
    addEar('a', 58, 60)
    addEar('a', 40, 60)
    addEar('a', 45, 70)
    selectEars('a', [0, 2])
    resizeSelectedEars('a', 12)
    expect(get().plate[0]!.brimPoints!.map((q) => q[3])).toEqual([6, defaultHeadDiameter() / 2, 6])
    selectEars('a', [2], 'remove')
    removeSelectedEars('a')
    expect(get().plate[0]!.brimPoints).toHaveLength(2)
    expect(get().plate[0]!.brimPoints![0]![3]).toBeCloseTo(defaultHeadDiameter() / 2, 4)
  })

  it('moves an ear to the hit point, keeping its height', () => {
    addEar('a', 58, 60)
    const z = get().plate[0]!.brimPoints![0]![2]
    moveEar('a', 0, 70, 66, false)
    moveEar('a', 0, 72, 68, true)
    const p = get().plate[0]!.brimPoints![0]!
    expect([p[0], p[1], p[2]]).toEqual([22, 8, z])
  })

  it('auto-generates ears at the corners of the first layer: four for a box, none twice', () => {
    expect(autoGenerateEars('a', { maxAngle: 125, detection: 1 })).toBe(4)
    const xs = get().plate[0]!.brimPoints!.map((q) => `${Math.round(q[0])},${Math.round(q[1])}`).sort()
    expect(xs).toEqual(['-5,-5', '-5,5', '5,-5', '5,5'])
    expect(autoGenerateEars('a', { maxAngle: 125, detection: 1 })).toBe(0)
  })

  it('flags an ear that does not reach the first layer', () => {
    addEar('a', 56, 60, 6)
    addEar('a', 90, 60, 6)
    const ears = worldEars(get().plate[0]!)
    expect(ears.map((e) => e.error)).toEqual([false, true])
  })

  it('chains ears: one that overlaps a connected ear is connected', () => {
    addEar('a', 56, 60, 6)
    addEar('a', 61, 60, 6)
    expect(worldEars(get().plate[0]!).every((e) => !e.error)).toBe(true)
  })
})

describe('brim ears in a project file', () => {
  it('are written per build item and read back unchanged', async () => {
    const a = { ...entry('o1'), brimPoints: [[1.5, 2.5, -0.1, 6], [3, 4, 0, 5.5]] as [number, number, number, number][] }
    const b = entry('o2', [150, 60, 5])
    const c = { ...entry('o3', [200, 60, 5]), brimPoints: [[0, 0, -0.0001, 8]] as [number, number, number, number][] }
    const input = { plates: [{ id: 'p1', name: 'Plate 1', objects: [a, b, c], settings: { sequence: 'by-layer' as const } }], bed, settings: {} }
    const text = String(projectFiles(input).find((f) => f.name === 'Metadata/brim_ear_points.txt')!.data)
    expect(text.split('\n')).toEqual(['brim_points_format_version=0', 'object_id=1|1.5 2.5 -0.1 6 3 4 0 5.5', 'object_id=3|0 0 -0.0001 8', ''])
    const p = await readProject(writeProject(input), bed)
    const objs = p.plates[0]!.objects
    expect(objs[0]!.brimPoints).toEqual([[1.5, 2.5, -0.1, 6], [3, 4, 0, 5.5]])
    expect(objs[1]!.brimPoints).toBeUndefined()
    expect(objs[2]!.brimPoints).toEqual([[0, 0, -0.0001, 8]])
  })

  it('drops bad numbers and absurd radii from a file', () => {
    const bytes = new TextEncoder().encode('brim_points_format_version=0\nobject_id=1|1 2 3 4 x 2 3 4 1 1 1 999 5 5 -0.1 7\nobject_id=2|junk\n')
    expect([...parseBrimEars(bytes)]).toEqual([[1, [[1, 2, 3, 4], [5, 5, -0.1, 7]]]])
  })
})
