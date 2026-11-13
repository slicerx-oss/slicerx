// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cut that keeps both pieces names its upper piece when the step says how (plane.cut `name`), on the mesh and on
// exact solids alike, and calls it "<part> top" when it does not, as before. A stand-in engine.
import { beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY, clearReplayCache, replayHistory, type History, type Step, type StepParams } from '@slicerx/cad-history'

const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }

function engine() {
  let n = 0
  return async (op: string) => {
    if (op === 'brep.tessellate') return { ...tri, faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.cut') return { below: 1, above: 2, belowSmb: `below-${++n}`, aboveSmb: `above-${n}` }
    if (op.startsWith('brep.')) return { body: 1, bodySmb: `${op.slice(5)}-${++n}` }
    if (op === 'cut') return { below: tri, above: tri }
    return { mesh: tri }
  }
}

const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: [...IDENTITY], params })
const box = step('box-1', { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams)
const cut = (name?: string, keep: 'both' | 'below' | 'above' = 'both') => step('cut-1', { op: 'plane.cut', plane: { point: [0, 0, 2], normal: [0, 0, 1] }, keep, ...(name ? { name } : {}) } as StepParams)
const history = (...steps: Step[]): History => ({ version: 1, base: [], steps })

beforeEach(() => clearReplayCache())

describe('a cut that names its upper piece', () => {
  for (const exact of [false, true]) {
    it(`names it on ${exact ? 'exact solids' : 'the mesh'}, and calls it "<part> top" without a name`, async () => {
      const named = await replayHistory(engine(), { history: history(box, cut('Upper hull')), exact })
      expect(named.status.map((s) => s.state)).toEqual(['done', 'done'])
      expect(named.parts.map((p) => p.name)).toEqual(['Body', 'Upper hull'])
      clearReplayCache()
      const plain = await replayHistory(engine(), { history: history(box, cut()), exact })
      expect(plain.parts.map((p) => p.name)).toEqual(['Body', 'Body top'])
    })
  }
})
