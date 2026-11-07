// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft step in the project file: profiles with up to 64 landmarks read back as written; a profile with more leaves
// that object's history out instead of handing the engine a step it refuses.
import { historyFiles, parseHistories, type History, type StepParams } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const SQUARE = { points: [[0, 0], [10, 0], [10, 10], [0, 10]] }

/** `n` landmarks spread around the square. */
const marks = (n: number): number[][] =>
  Array.from({ length: n }, (_, i) => {
    const d = (i * 40) / n
    return d < 10 ? [d, 0] : d < 20 ? [10, d - 10] : d < 30 ? [30 - d, 10] : [0, 40 - d]
  })

const loft = (n: number): Record<string, unknown> => ({
  op: 'sketch.loft',
  profiles: [
    { frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [SQUARE], landmarks: marks(n) },
    { frame: { origin: [0, 0, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [SQUARE], landmarks: marks(n) },
  ],
})

/** The history of one object holding `params` as its only step, written to the file and read back. */
function roundTrip(params: Record<string, unknown>): History | undefined {
  const h: History = { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: T, params: params as unknown as StepParams }] } as History
  const files = historyFiles([{ id: 'a', history: h }], new Map([['a', 3]]))
  const map = new Map(files.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
  return parseHistories(map, new Set(['3'])).get('3')
}

describe('a loft step in the project file', () => {
  it('reads back profiles with 64 landmarks and leaves out a history with 65', () => {
    expect(roundTrip(loft(64))?.steps[0]?.params).toEqual(loft(64))
    expect(roundTrip(loft(65))).toBeUndefined()
  })
})
