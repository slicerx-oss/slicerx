// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plain 3MF's touching objects open as one object with their parts; Keep separate puts the file's objects back.
import { describe, expect, it } from 'vitest'
import type { ImportedObject } from '../src/export/import3mf'
import { joinObjects, separateAgain, touchGroups } from '../src/state/open-join'
import { bounds, compose } from '../src/plate/transform'

const at = (x: number, y: number, z: number) => compose({ position: [x, y, z], rotation: [0, 0, 0], scale: [1, 1, 1] })

/** A 10 mm cube on its own origin, placed at `t`, its one part on filament `slot`. */
function cube(name: string, slot: number, t: number[]): ImportedObject {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7])
  return { name, parts: [{ name, slot, positions, indices }], volumes: [], transform: t, fileId: name }
}

describe('touchGroups', () => {
  it('joins pairs into groups, leaves loners out, in file order', () => {
    expect(touchGroups(5, [[3, 1], [1, 4]])).toEqual([[1, 3, 4]])
    expect(touchGroups(4, [[2, 3], [0, 1]])).toEqual([[0, 1], [2, 3]])
    expect(touchGroups(3, [])).toEqual([])
  })
})

describe('joinObjects', () => {
  it('keeps every part where it was, with its own filament', () => {
    const a = cube('A', 1, at(5, 5, 0))
    const b = cube('B', 2, at(5, 5, 10))
    const j = joinObjects([a, b], 'x-mark')
    expect(j.name).toBe('x-mark')
    expect(j.parts.map((p) => p.slot)).toEqual([1, 2])
    expect(bounds([j.parts[1]!], j.transform)!.min[2]).toBeCloseTo(10)
    expect(j.transform).not.toBe(a.transform)
  })

  it('separates again where the joined object was moved to', () => {
    const a = cube('A', 1, at(5, 5, 0))
    const b = cube('B', 2, at(5, 5, 10))
    const j = joinObjects([a, b], 'x-mark')
    const [ta, tb] = separateAgain(at(25, 5, 0), j.transform, [a, b])
    expect(bounds(a.parts, ta!)!.min).toEqual([25, 5, 0])
    expect(bounds(b.parts, tb!)!.min[0]).toBeCloseTo(25)
    expect(bounds(b.parts, tb!)!.min[2]).toBeCloseTo(10)
  })
})
