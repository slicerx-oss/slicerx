// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An array of separate copies records each copy's move from the part it copied (copyOf), and the project file keeps
// it through a version 2 and a version 3 file. A copyOf that does not fit its step is dropped, the step kept; a step
// saved without one opens as before. A lean on the step drops it, since each copy then turns on its own.
import { describe, expect, it } from 'vitest'
import { historyFiles, parseHistories, parseTimeline, tiltedParams, timelineFiles, timelineOf, type FeatureItem, type History, type StepParams } from '@slicerx/cad-history'
import { boxMesh } from '../src/plate/mesh-ops'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const moved = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]
const copies = (copyOf: unknown, n = 2) => ({ op: 'parts.add', parts: Array.from({ length: n }, (_, k) => ({ ...boxMesh(2, 2, 2), name: `Boat ${k + 2}` })), label: `Array of ${n + 1}, separate`, arrayOf: 'Boat', copyOf }) as unknown as StepParams
const bytes = (list: { name: string; data: string | Uint8Array }[]) => new Map(list.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
const history = (params: StepParams): History => ({ version: 1, base: [boxMesh(10, 10, 5)], steps: [{ id: 's1', part: 0, transform: T, params }] })
const v2 = (params: StepParams) => parseHistories(bytes(historyFiles([{ id: 'o1', history: history(params) }], new Map([['o1', 1]]))), new Set(['1'])).get('1')?.steps[0]?.params
const v3 = (params: StepParams) =>
  parseTimeline(bytes(timelineFiles(timelineOf([{ id: 'o1', history: history(params) }]), new Map([['o1', 1]]))), new Set(['1']))!.items.filter((i): i is FeatureItem => i.kind === 'feature')[0]?.params

describe("the moves of an array's separate copies", () => {
  it('come back from a version 2 and a version 3 file', () => {
    const copyOf = { part: 0, moves: [moved(15), moved(30)] }
    for (const read of [v2, v3]) expect((read(copies(copyOf)) as { copyOf?: unknown }).copyOf).toEqual(copyOf)
  })

  it('are dropped when they do not fit the step, and the step is kept', () => {
    const bad = [{ part: 0, moves: [moved(15)] }, { part: -1, moves: [moved(15), moved(30)] }, { part: 0.5, moves: [moved(15), moved(30)] }, { part: 0, moves: [moved(15), [1, 2, 3]] }, { part: 0 }, 'Boat']
    for (const copyOf of bad) {
      for (const read of [v2, v3]) {
        const back = read(copies(copyOf)) as { op: string; copyOf?: unknown; arrayOf?: string } | undefined
        expect(back?.op, JSON.stringify(copyOf)).toBe('parts.add')
        expect(back && 'copyOf' in back, JSON.stringify(copyOf)).toBe(false)
        expect(back?.arrayOf).toBe('Boat')
      }
    }
  })

  it('are left out of a step saved without them, which opens as before', () => {
    const { copyOf: _none, ...plain } = copies(undefined) as StepParams & { copyOf?: unknown }
    expect(v2(plain as StepParams)).toEqual(plain)
  })

  it('go when the step leans, as each copy turns on its own', () => {
    const p = tiltedParams(copies({ part: 0, moves: [moved(15), moved(30)] }), { degrees: 10, up: [0, 0, 1], toward: [0, 1, 0] })
    expect(p.op).toBe('parts.add')
    expect('copyOf' in p).toBe(false)
  })
})
