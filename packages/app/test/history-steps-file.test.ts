// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every kind of history step the tools record comes back from the project file, so a project with a hole, a
// thread or a shell opens with its whole history (export/history-read.ts checks each step's parameters).
import { describe, expect, it } from 'vitest'
import type { History, StepParams } from '../src/cad/history/model'
import { historyFiles } from '../src/export/history-file'
import { parseHistories } from '../src/export/history-read'
import { boxMesh } from '../src/plate/mesh-ops'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const STEPS: StepParams[] = [
  { op: 'hole.apply', hole: { entry: [0, 0, 5], axis: [0, 0, 1], diameterMm: 6, depthMm: 5, through: true }, spec: { diameterMm: 3.4 }, label: 'M3 clearance' },
  { op: 'thread.apply', thread: { start: [0, 0, 5], axis: [0, 0, 1], diameterMm: 6.8, lengthMm: 5, internal: true, openEnd: true }, spec: { size: 'M8', clearanceMm: 0.1 }, label: 'M8 thread' },
  { op: 'shell', open: [{ at: [0, 0, 5], normal: [0, 0, 1] }], wallMm: 2 },
  { op: 'shape.extrude', frame: { origin: [0, 0, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 4 }, placement: {}, spec: { distanceMm: 5, operation: 'cut' }, pattern: { kind: 'circular', count: 6, center: [10, 0] } },
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

  it("keeps a step's own name", () => {
    const history: History = { version: 1, base: [boxMesh(10, 10, 5)], steps: [{ id: 's1', part: 0, transform: T, params: STEPS[2]!, label: 'Walls' }] }
    const files = new Map(historyFiles([{ id: 'o1', history }], new Map([['o1', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    expect(parseHistories(files, new Set(['1'])).get('1')?.steps[0]?.label).toBe('Walls')
  })

  it('drops a step whose parameters are wrong', () => {
    expect(roundTrip({ op: 'shape.extrude', frame: { origin: [0, 0, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 4 }, placement: {}, spec: { distanceMm: 5, operation: 'cut' }, pattern: { kind: 'spiral', count: 3 } } as unknown as StepParams)).toBeUndefined()
    expect(roundTrip({ op: 'shell', open: [{ at: [0, 0], normal: [0, 0, 1] }], wallMm: 2 } as unknown as StepParams)).toBeUndefined()
    expect(roundTrip({ op: 'thread.apply', thread: { start: [0, 0, 5] }, spec: { size: 8 }, label: 'x' } as unknown as StepParams)).toBeUndefined()
    expect(roundTrip({ op: 'hole.apply', hole: {}, spec: { diameterMm: 'big' }, label: 'x' } as unknown as StepParams)).toBeUndefined()
  })
})

describe('a shell step', () => {
  it('is named by its wall and open faces, and its wall is the number a person changes', async () => {
    const { mainNumber, stepName, withNumber } = await import('../src/cad/history/model')
    const step = { id: 's', part: 0, transform: T, params: STEPS[2]! }
    expect(stepName(step)).toBe('Shell, 2 mm walls, 1 open face')
    expect(mainNumber(step.params)).toMatchObject({ label: 'Wall', value: 2, unit: 'mm' })
    expect(withNumber(step.params, 3)).toMatchObject({ op: 'shell', wallMm: 3 })
    expect(withNumber(step.params, 0)).toMatch(/more than 0/)
  })
})

describe('a patterned step', () => {
  it('names its copies', async () => {
    const { stepName } = await import('../src/cad/history/model')
    expect(stepName({ params: STEPS[3]! })).toBe('Hole 4 mm, 6 copies')
  })
})
