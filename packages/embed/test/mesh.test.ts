// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A decoded STL keeps what was taken off its coordinates, and fileTransform puts it back, so a slice request that
// names the file places it where the viewport shows it.
import { describe, expect, it } from 'vitest'
import { decodeStl, fileTransform } from '../src/mesh'

const stl = (pts: [number, number, number][]) => new TextEncoder().encode(`solid t\nfacet normal 0 0 1\nouter loop\n${pts.map((p) => `vertex ${p.join(' ')}`).join('\n')}\nendloop\nendfacet\nendsolid t\n`).buffer as ArrayBuffer

/** A point through a column-major 4x4. */
const apply = (m: number[], [x, y, z]: number[]) => [0, 1, 2].map((r) => m[r]! * x! + m[4 + r]! * y! + m[8 + r]! * z! + m[12 + r]!)

describe('fileTransform', () => {
  const model = decodeStl(stl([[10, 20, 5], [30, 20, 5], [10, 60, 25]]), 'tri.stl')

  it('records the offset an STL was moved by', () => {
    expect(model.offset).toEqual([20, 40, 5])
    expect(Array.from(model.parts[0]!.positions.slice(0, 3))).toEqual([-10, -20, 0])
  })

  it('places each file vertex where the viewport draws the decoded one, turned and moved', () => {
    const c = Math.cos(0.7)
    const s = Math.sin(0.7)
    const viewport = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 128, 100, 3, 1]
    const file = fileTransform(viewport, model.offset)
    const local = Array.from(model.parts[0]!.positions)
    const raw = [10, 20, 5, 30, 20, 5, 10, 60, 25]
    for (let i = 0; i < 9; i += 3) {
      const a = apply(viewport, local.slice(i, i + 3))
      const b = apply(file, raw.slice(i, i + 3))
      for (let k = 0; k < 3; k++) expect(b[k]).toBeCloseTo(a[k]!, 4)
    }
  })
})
