// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A round edge (a hole's rim, a boss's root) is kept by a corner on its circle and the circle's center. When the
// face it sits on moves in a history replay, both move with it, so the engine finds the rim at its new place.
import type { MeshPart } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { followed, type History, type StepParams } from '../src/cad/history/model'
import { withStep } from '../src/cad/history/record'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'

const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const pull = (distanceMm: number): StepParams => ({ op: 'face.push', at: [100, 100, 5], normal: [0, 0, 1], distanceMm })
const rimFillet: StepParams = {
  op: 'edge.fillet',
  edges: [{ a: [103, 100, 10], b: [103, 100, 10], face: [0, 0, 1], center: [100, 100, 10] }],
  radiusMm: 1,
}

describe('a round edge in the history', () => {
  it('moves its corner and its center with the face it sits on', () => {
    let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [boxMesh(40, 20, 5)] as MeshPart[], transform: T }
    for (const p of [pull(5), rimFillet]) e = { ...e, history: withStep(e, 0, p) }
    const steps = e.history!.steps.map((s, i) => (i === 0 ? { ...s, params: pull(8) } : s))
    const moved = followed(steps[1]!, steps).params
    expect(moved.op).toBe('edge.fillet')
    if (moved.op !== 'edge.fillet') return
    expect(moved.edges[0]!.a).toEqual([103, 100, 13])
    expect(moved.edges[0]!.b).toEqual([103, 100, 13])
    expect(moved.edges[0]!.center).toEqual([100, 100, 13])
  })
})
