// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps repeated as one step in the open app, on a body the app landed in the middle of the plate: the copies sit in
// the design's own coordinates, as the steps they repeat do, and the step shows in the object's history.
import type { MeshHandle } from '@slicerx/contracts'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { stepIcon } from '../src/cad/history/step-icon'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('app-link-feature-pattern-replies', { compressed: true, freshCache: true })
beforeAll(() => useDesignHost({ loadParts: async (id: string): Promise<MeshHandle> => ({ id, hash: id, name: id, triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [] }) }))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

type Body = { design: string; steps: number; minMm: number[]; sizeMm: number[]; volumeMm3: number; lastStep: { state: string } }
async function output(name: string, args: Record<string, unknown>): Promise<Body> {
  const reply = (await runCall(name, args)) as { output: Body }
  return reply.output
}

/** A 40 x 20 x 10 mm toy boat deck with one 4 x 4 mm, 2 mm deep hatch on its top near the stern. */
async function deck(): Promise<string> {
  const { design } = await output('design.new', { name: 'Toy boat deck' })
  await output('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 10 })
  const hatch = await output('geom.subtract', { design, part: 0, solids: [{ type: 'box', min: [-14, -2, 8], max: [-10, 2, 10] }] })
  expect(hatch.volumeMm3).toBeCloseTo(8000 - 32, 1)
  return design
}

it('repeats a hatch along the deck of a landed body as one step in its history', async () => {
  const design = await deck()
  expect(get().plate[0]!.transform.slice(12, 14)).toEqual([128, 128])
  const row = await output('geom.array', { design, steps: [2], spec: { kind: 'linear', count: 4, step: [8, 0, 0] } })
  expect(row.steps).toBe(3)
  expect(row.lastStep.state).toBe('done')
  expect(row.volumeMm3).toBeCloseTo(8000 - 4 * 32, 1)
  expect(row.minMm).toEqual([-20, -10, 0])
  const steps = get().plate[0]!.history!.steps
  expect(steps[2]!.params).toMatchObject({ op: 'pattern', steps: [steps[1]!.id] })
  expect(stepIcon(steps[2]!.params)).toBe('array-linear')
  // undone as one step
  await runCall('design.undo', { design })
  expect(get().plate[0]!.history!.steps).toHaveLength(2)
}, 60_000)

it('mirrors a hatch through a plane in the design\'s own coordinates on a landed body', async () => {
  const design = await deck()
  // through x = -11, a millimeter inside the hatch (x -14 to -10): its image (x -12 to -8) overlaps it by 2 mm
  const both = await output('geom.mirror', { design, steps: [2], plane: { axis: 'x', at: -11 } })
  expect(both.lastStep.state).toBe('done')
  expect(both.volumeMm3).toBeCloseTo(8000 - 6 * 4 * 2, 1)
  expect(stepIcon(get().plate[0]!.history!.steps[2]!.params)).toBe('mirror')
}, 60_000)
