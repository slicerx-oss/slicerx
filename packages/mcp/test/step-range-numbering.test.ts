// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The height ranges cad-history reads for each part from the steps alone (partRanges) number the parts as replay does:
// a turned-off union keeps the part it would have taken in, after the numbered parts, and parts a step adds go after
// every part. Each history is replayed with the engine, and each part's range from the steps is the height the
// replayed part takes up; a part made of added mesh parts has no range.
import { describe, expect, it } from 'vitest'
import { IDENTITY, partRanges, replayHistory, type History, type HistoryMesh, type Step, type StepParams } from '@slicerx/cad-history'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('step-range-numbering')

const step = (id: string, part: number, params: StepParams, suppressed = false): Step => ({ id, part, transform: [...IDENTITY], params, ...(suppressed ? { suppressed: true } : {}) }) as Step
/** A new 10 mm block `h` tall, at x on the bed. */
const block = (id: string, part: number, x: number, h: number) => step(id, part, { op: 'shape.extrude', shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, placement: { center: [x, 0] }, spec: { distanceMm: h, operation: 'new' } } as StepParams)
const union = (id: string, part: number, other: number, off: boolean) => step(id, part, { op: 'boolean', kind: 'union', with: [other] } as StepParams, off)
/** A 4 mm cube of mesh at x, 50 to 54 mm up: a part a step adds. */
function cube(x: number): HistoryMesh {
  const positions = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => [x + (k & 1 ? 4 : 0), k & 2 ? 4 : 0, 50 + (k & 4 ? 4 : 0)])
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]
  return { name: 'Added', slot: 1, positions, indices } as HistoryMesh
}

/** Each replayed part's height, lowest to highest point, rounded to 0.01 mm. */
async function replayedHeights(steps: Step[]): Promise<[number, number][]> {
  const history: History = { version: 1, base: [], steps }
  const r = await replayHistory((op, request) => geom.engine(op, request), { history })
  expect(r.status.map((s) => s.state).filter((s) => s !== 'done' && s !== 'suppressed')).toEqual([])
  return r.parts.map((p) => {
    const zs = Array.from(p.positions).filter((_, i) => i % 3 === 2)
    return [Math.round(Math.min(...zs) * 100) / 100, Math.round(Math.max(...zs) * 100) / 100]
  })
}

/** The ranges partRanges reads after every step, as [lo, hi] or null. */
function readRanges(steps: Step[]): ([number, number] | null)[] | null {
  const r = partRanges(steps, steps.length, (id) => steps.find((s) => s.id === id))
  return r && r.map((x) => (x ? [Math.round(x.lo * 100) / 100, Math.round(x.hi * 100) / 100] : null))
}

describe('the ranges read from the steps number the parts as replay does', () => {
  it('keeps the part a turned-off union would take in, after the numbered parts', async () => {
    // blocks A (10 mm), B (20 mm), A joined with B, block C (30 mm); the union turned off gives A, C and B
    const steps = [block('a', 0, 0, 10), block('b', 1, 30, 20), union('u', 0, 1, true), block('c', 1, 60, 30)]
    const replayed = await replayedHeights(steps)
    expect(replayed).toEqual([[0, 10], [0, 30], [0, 20]])
    expect(readRanges(steps)).toEqual(replayed)
  })

  it('puts parts a step adds after every part, the parts a turned-off union kept among them', async () => {
    // as above, then a mesh part added: A, C, B and the added cube; the added part has no range
    const add = step('m', -1, { op: 'parts.add', parts: [cube(90)], label: 'Built solids' } as unknown as StepParams)
    const steps = [block('a', 0, 0, 10), block('b', 1, 30, 20), union('u', 0, 1, true), block('c', 1, 60, 30), add]
    const replayed = await replayedHeights(steps)
    expect(replayed).toEqual([[0, 10], [0, 30], [0, 20], [50, 54]])
    expect(readRanges(steps)).toEqual([[0, 10], [0, 30], [0, 20], null])
  })
})
