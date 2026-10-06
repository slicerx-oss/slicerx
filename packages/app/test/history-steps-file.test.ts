// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every kind of history step the tools record comes back from the project file, so a project with a hole or a
// thread opens with its whole history (export/history-read.ts checks each step's parameters).
import { describe, expect, it } from 'vitest'
import type { History, StepParams } from '../src/cad/history/model'
import { historyFiles } from '../src/export/history-file'
import { parseHistories } from '../src/export/history-read'
import { boxMesh } from '../src/plate/mesh-ops'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const STEPS: StepParams[] = [
  { op: 'hole.apply', hole: { entry: [0, 0, 5], axis: [0, 0, 1], diameterMm: 6, depthMm: 5, through: true }, spec: { diameterMm: 3.4 }, label: 'M3 clearance' },
  { op: 'thread.apply', thread: { start: [0, 0, 5], axis: [0, 0, 1], diameterMm: 6.8, lengthMm: 5, internal: true, openEnd: true }, spec: { size: 'M8', clearanceMm: 0.1 }, label: 'M8 thread' },
]

function roundTrip(params: StepParams): History | undefined {
  const history: History = { version: 1, base: [boxMesh(10, 10, 5)], steps: [{ id: 's1', part: 0, transform: T, params }] }
  const files = new Map(historyFiles([{ id: 'o1', history }], new Map([['o1', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
  return parseHistories(files, new Set(['1'])).get('1')
}

describe('history steps in the project file', () => {
  for (const p of STEPS) {
    it(`keeps a ${p.op} step`, () => {
      expect(roundTrip(p)?.steps[0]?.params).toEqual(p)
    })
  }

  it('drops a step whose parameters are wrong', () => {
    expect(roundTrip({ op: 'thread.apply', thread: { start: [0, 0, 5] }, spec: { size: 8 }, label: 'x' } as unknown as StepParams)).toBeUndefined()
    expect(roundTrip({ op: 'hole.apply', hole: {}, spec: { diameterMm: 'big' }, label: 'x' } as unknown as StepParams)).toBeUndefined()
  })
})
