// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part whose exact solid grows past the largest solid text a part keeps (MAX_SOLID_TEXT) is built as a mesh from
// that step on, and the step says so with the size and the limit. A design that must stay exact stops there instead.
// Nothing about it is silent. The app's step list shows the step's sentence (withStatus).
import { beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY, MAX_SOLID_TEXT, clearReplayCache, replayHistory, solidTooBig, type History, type Step, type StepParams } from '@slicerx/cad-history'
import { withStatus } from '../src/cad/history/ops'

const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }

/** An engine whose kernel answers the cut with a solid text `chars` long, and every other solid with a short one. */
function engine(chars: number) {
  const ops: string[] = []
  const call = async (op: string, request: unknown) => {
    ops.push(op)
    if (op === 'brep.tessellate') return { ...tri, faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.subtract') return { body: 1, bodySmb: 'x'.repeat(chars) }
    if (op.startsWith('brep.')) return { body: 1, bodySmb: `${op}-solid` }
    return { mesh: { ...tri, positions: [1, 0, 0, 10, 0, 0, 0, 10, 0] }, removedVolumeMm3: 1, req: request }
  }
  return { call, ops }
}

const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: [...IDENTITY], params })
const box = step('box', { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } })
const hole = (id: string) => step(id, { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole 4 mm' } as StepParams)
const history = (exact?: true): History => ({ version: 1, base: [], steps: [box, hole('hole-1'), hole('hole-2')], ...(exact ? { exact } : {}) })

beforeEach(() => clearReplayCache())

describe('a solid at the limit', () => {
  it('stays exact, with no note', async () => {
    const e = engine(MAX_SOLID_TEXT)
    const r = await replayHistory(e.call, { history: history(), exact: true })
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }])
    // the next cut goes to the kernel with the kept solid
    expect(e.ops.filter((o) => o === 'brep.subtract')).toHaveLength(2)
    const strict = await replayHistory(engine(MAX_SOLID_TEXT).call, { history: history(true) })
    expect(strict.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  })
})

describe('a solid one character past the limit', () => {
  it('says so on the step, and the part is built as a mesh from there', async () => {
    const e = engine(MAX_SOLID_TEXT + 1)
    const r = await replayHistory(e.call, { history: history(), exact: true })
    const sentence = solidTooBig(MAX_SOLID_TEXT + 1, false)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done', note: sentence }, { state: 'done' }])
    // the second cut runs on the mesh: the part kept no solid to send
    expect(e.ops.filter((o) => o === 'brep.subtract')).toHaveLength(1)
    expect(e.ops).toContain('subtract')
    // the step list shows it
    expect(withStatus(history().steps, r.status)[1]!.note).toBe(sentence)
  })

  it('stops a design that must stay exact, with the same size and limit', async () => {
    const r = await replayHistory(engine(MAX_SOLID_TEXT + 1).call, { history: history(true) })
    expect(r.status[1]).toEqual({ state: 'broken', message: solidTooBig(MAX_SOLID_TEXT + 1, true) })
    expect(r.status[2]).toEqual({ state: 'skipped' })
  })
})

describe('the sentences', () => {
  it('give the size and the limit in millions of characters, with enough places to tell them apart', () => {
    expect(solidTooBig(9_000_000, false)).toBe('This part is now too detailed to stay an exact solid, so from this step on it is built as a mesh. (Size 9 million, limit 8.4 million.)')
    expect(solidTooBig(8_900_000, true)).toBe('this step would make the part too detailed to stay an exact solid (size 8.9 million, limit 8.4 million).')
    expect(solidTooBig(8_430_000, false)).toContain('(Size 8.43 million, limit 8.39 million.)')
    expect(solidTooBig(MAX_SOLID_TEXT + 1, false)).toContain('(Size 8.388609 million, limit 8.388608 million.)')
  })
})
