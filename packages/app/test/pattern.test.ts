// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature patterns: a shape repeated on its face as one step. The app places the copies for the preview the same
// way the engine does (sx-geom face.rs, Pattern), counts them for the step's name, and says what is wrong with a
// pattern before it is sent.
import { describe, expect, it } from 'vitest'
import { copyCount, patternCopies, patternProblem, patternFromFields } from '../src/cad/pattern'

const close = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9

describe('pattern copies', () => {
  it('places a line, a grid and a circle as the engine does, the shape itself first', () => {
    const line = patternCopies({ kind: 'linear', count: 3, stepMm: [20, 0] })
    expect(line.map((f) => f([1, 1]))).toEqual([[1, 1], [21, 1], [41, 1]])
    const grid = patternCopies({ kind: 'linear', count: 2, stepMm: [10, 0], count2: 2, step2Mm: [0, 5] })
    expect(grid.map((f) => f([0, 0]))).toEqual([[0, 0], [10, 0], [0, 5], [10, 5]])
    const ring = patternCopies({ kind: 'circular', count: 4, center: [0, 0] })
    expect(close(ring[1]!([10, 0]), [0, 10])).toBe(true)
    expect(close(ring[2]!([10, 0]), [-10, 0])).toBe(true)
    // A partial sweep puts the last copy at its end.
    const arc = patternCopies({ kind: 'circular', count: 3, center: [0, 0], angleDeg: 90 })
    expect(close(arc[2]!([10, 0]), [0, 10])).toBe(true)
    expect(patternCopies({ kind: 'points', offsets: [[5, 0]] }).map((f) => f([1, 2]))).toEqual([[1, 2], [6, 2]])
    expect(copyCount({ kind: 'linear', count: 3, stepMm: [1, 0], count2: 4, step2Mm: [0, 1] })).toBe(12)
  })

  it('reads the fields, and says what is wrong in words', () => {
    expect(patternFromFields({ kind: 'none' }, Number)).toBeNull()
    expect(patternFromFields({ kind: 'line', count: '4', step: '12.5', angle: '0' }, Number)).toEqual({ kind: 'linear', count: 4, stepMm: [12.5, 0] })
    expect(patternFromFields({ kind: 'line', count: '3', step: '10', angle: '90' }, Number)).toMatchObject({ kind: 'linear', count: 3 })
    expect(patternFromFields({ kind: 'grid', count: '3', step: '10', count2: '2', step2: '8' }, Number)).toEqual({ kind: 'linear', count: 3, stepMm: [10, 0], count2: 2, step2Mm: [0, 8] })
    expect(patternFromFields({ kind: 'circle', count: '6', centerX: '0', centerY: '0', sweep: '360' }, Number)).toEqual({ kind: 'circular', count: 6, center: [0, 0], angleDeg: 360 })
    expect(patternProblem({ kind: 'linear', count: 1, stepMm: [10, 0] })).toMatch(/at least 2/)
    expect(patternProblem({ kind: 'linear', count: 3, stepMm: [0, 0] })).toMatch(/spacing/)
    expect(patternProblem({ kind: 'linear', count: 50, stepMm: [1, 0], count2: 50, step2Mm: [0, 1] })).toMatch(/500/)
    expect(patternProblem({ kind: 'circular', count: 6, center: [0, 0], angleDeg: 400 })).toMatch(/360/)
    expect(patternProblem({ kind: 'circular', count: 6, center: [0, 0] })).toBeNull()
  })
})
