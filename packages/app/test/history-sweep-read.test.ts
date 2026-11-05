// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sweep step in the project file: a good one reads back as written and is named Sweep or Sweep cut; a damaged one
// leaves that object's history out instead of replaying something the engine would refuse.
import { historyFiles, parseHistories, stepName, type History, type StepParams } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const SQUARE = { points: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }

const sweep = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  op: 'sketch.sweep',
  profile: { loops: [SQUARE] },
  path: { points: [[0, 0, 0], [0, 0, 20]] },
  ...extra,
})

/** The history of one object holding `params` as its only step, written to the file and read back. */
function roundTrip(params: Record<string, unknown>): History | undefined {
  const h: History = { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: T, params: params as unknown as StepParams }] } as History
  const files = historyFiles([{ id: 'a', history: h }], new Map([['a', 3]]))
  const map = new Map(files.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
  return parseHistories(map, new Set(['3'])).get('3')
}

describe('a sweep step in the project file', () => {
  it('reads back a sweep along points and along a chain on a plane', () => {
    const back = roundTrip(sweep({ operation: 'join', name: 'Rail' }))
    expect(back?.steps[0]?.params).toEqual(sweep({ operation: 'join', name: 'Rail' }))
    const frame = { origin: [0, 0, 0], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }
    const chain = sweep({ path: { frame, loops: [{ start: [0, 0], segments: [{ type: 'arc', center: [10, 0], sweepDeg: -90 }] }] } })
    expect(roundTrip(chain)?.steps[0]?.params).toEqual(chain)
  })

  it('leaves out a history whose sweep is damaged', () => {
    const bad: Record<string, unknown>[] = [
      sweep({ path: { points: [[0, 0, 0], [0, 0, 20]], loops: [{ points: [[0, 0], [1, 0]] }] } }),
      sweep({ path: {} }),
      sweep({ path: { points: [[0, 0], [0, 20]] } }),
      sweep({ path: { points: [[0, 0, 0], [0, 0, Number.NaN]] } }),
      sweep({ operation: 'x' }),
      sweep({ profile: {} }),
    ]
    for (const p of bad) expect(roundTrip(p), JSON.stringify(p)).toBeUndefined()
  })

  it('names the step Sweep, or Sweep cut', () => {
    expect(stepName({ params: sweep() as unknown as StepParams })).toBe('Sweep')
    expect(stepName({ params: sweep({ operation: 'cut' }) as unknown as StepParams })).toBe('Sweep cut')
  })
})
