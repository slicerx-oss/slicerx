// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every kind of history step the tools record comes back from the project file, so a project with a hole, a
// thread or a shell opens with its whole history (@slicerx/cad-history read.ts checks each step's parameters).
import { describe, expect, it } from 'vitest'
import { historyFiles, parseHistories, parseTimeline, timelineFiles, timelineOf, type FeatureItem, type History, type StepParams } from '@slicerx/cad-history'
import { boxMesh } from '../src/plate/mesh-ops'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const STEPS: StepParams[] = [
  { op: 'hole.apply', hole: { entry: [0, 0, 5], axis: [0, 0, 1], diameterMm: 6, depthMm: 5, through: true }, spec: { diameterMm: 3.4 }, label: 'M3 clearance' },
  { op: 'thread.apply', thread: { start: [0, 0, 5], axis: [0, 0, 1], diameterMm: 6.8, lengthMm: 5, internal: true, openEnd: true }, spec: { size: 'M8', clearanceMm: 0.1 }, label: 'M8 thread' },
  { op: 'shell', open: [{ at: [0, 0, 5], normal: [0, 0, 1] }], wallMm: 2 },
  { op: 'shape.extrude', frame: { origin: [0, 0, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 4 }, placement: {}, spec: { distanceMm: 5, operation: 'cut' }, pattern: { kind: 'circular', count: 6, center: [10, 0] } },
]

describe('a step that sets a part\'s filament', () => {
  it('comes back from the project file, and one with a slot no filament has is dropped', () => {
    const p = { op: 'parts.slot', slot: 3, name: 'Funnel' } as StepParams
    expect(roundTrip(p)?.steps[0]?.params).toEqual(p)
    for (const slot of [0, 33, 2.5, '3']) expect(roundTrip({ op: 'parts.slot', slot, name: 'Funnel' } as unknown as StepParams), String(slot)).toBeUndefined()
    expect(roundTrip({ op: 'parts.slot', slot: 3 } as unknown as StepParams)).toBeUndefined()
  })
})

describe('a cut that names its upper piece', () => {
  it('comes back from the project file with its name, an old cut as before, and one whose name is not text is dropped', () => {
    const plane = { point: [0, 0, 2], normal: [0, 0, 1] }
    const named = { op: 'plane.cut', plane, keep: 'both', name: 'Upper hull' } as StepParams
    expect(roundTrip(named)?.steps[0]?.params).toEqual(named)
    const old = { op: 'plane.cut', plane, keep: 'both' } as StepParams
    expect(roundTrip(old)?.steps[0]?.params).toEqual(old)
    for (const name of [3, '', 'x'.repeat(121)]) expect(roundTrip({ op: 'plane.cut', plane, keep: 'both', name } as unknown as StepParams), String(name).slice(0, 8)).toBeUndefined()
  })
})

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

  it('keeps the part an array of separate copies copied, and drops a name no part could have', () => {
    const copies = (arrayOf: unknown) => ({ op: 'parts.add', parts: [{ ...boxMesh(2, 2, 2), name: 'Segment 1 2' }], label: 'Array of 2, separate', arrayOf }) as unknown as StepParams
    // kept as written, up to the 120 characters the tools take
    for (const good of ['Segment 1', 'x'.repeat(120), '  Segment 1']) expect((roundTrip(copies(good))?.steps[0]?.params as { arrayOf?: string }).arrayOf, good).toBe(good)
    for (const bad of ['x'.repeat(121), '   ', 7]) {
      const back = roundTrip(copies(bad))?.steps[0]?.params as { op: string; arrayOf?: string } | undefined
      expect(back?.op, String(bad)).toBe('parts.add')
      expect(back && 'arrayOf' in back, String(bad)).toBe(false)
    }
  })

  it("keeps a step's own name", () => {
    const history: History = { version: 1, base: [boxMesh(10, 10, 5)], steps: [{ id: 's1', part: 0, transform: T, params: STEPS[2]!, label: 'Walls' }] }
    const files = new Map(historyFiles([{ id: 'o1', history }], new Map([['o1', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    expect(parseHistories(files, new Set(['1'])).get('1')?.steps[0]?.label).toBe('Walls')
  })

  it("keeps the plan feature each step was tagged with, through a version 2 and a version 3 file", () => {
    const history: History = {
      version: 1,
      base: [boxMesh(10, 10, 5)],
      steps: [
        { id: 's1', part: 0, transform: T, params: STEPS[0]!, feature: ' Base plate ' },
        { id: 's2', part: 0, transform: T, params: STEPS[2]!, feature: 'Mounting holes' },
        { id: 's3', part: 0, transform: T, params: STEPS[3]! },
        { id: 's4', part: 0, transform: T, params: STEPS[3]!, feature: 'x'.repeat(80) },
        { id: 's5', part: 0, transform: T, params: STEPS[3]!, feature: '   ' },
      ],
    }
    const bytes = (list: { name: string; data: string | Uint8Array }[]) => new Map(list.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    const want = ['Base plate', 'Mounting holes', undefined, 'x'.repeat(60), undefined]
    const v2 = parseHistories(bytes(historyFiles([{ id: 'o1', history }], new Map([['o1', 1]]))), new Set(['1'])).get('1')!
    expect(v2.steps.map((st) => st.feature)).toEqual(want)
    const v3 = parseTimeline(bytes(timelineFiles(timelineOf([{ id: 'o1', history }]), new Map([['o1', 1]]))), new Set(['1']))!
    expect(v3.items.filter((i): i is FeatureItem => i.kind === 'feature').map((f) => f.feature)).toEqual(want)
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
    const { mainNumber, stepName, withNumber } = await import('@slicerx/cad-history')
    const step = { id: 's', part: 0, transform: T, params: STEPS[2]! }
    expect(stepName(step)).toBe('Shell, 2 mm walls, 1 open face')
    expect(mainNumber(step.params)).toMatchObject({ label: 'Wall', value: 2, unit: 'mm' })
    expect(withNumber(step.params, 3)).toMatchObject({ op: 'shell', wallMm: 3 })
    expect(withNumber(step.params, 0)).toMatch(/more than 0/)
  })
})

describe('a patterned step', () => {
  it('names its copies', async () => {
    const { stepName } = await import('@slicerx/cad-history')
    expect(stepName({ params: STEPS[3]! })).toBe('Hole 4 mm, 6 copies')
  })
})
