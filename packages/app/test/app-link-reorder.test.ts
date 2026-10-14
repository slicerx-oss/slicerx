// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { clearReplayCache } from '@slicerx/cad-history'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('app-link-reorder-replies')
const handle = (name: string): MeshHandle => ({ id: name, hash: name, name, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
beforeAll(() => useDesignHost({ loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }))
beforeEach(() => {
  clearReplayCache()
  set({ plate: [], historyEdit: null, rollback: null, timeline: { bodies: [], items: [], marker: 0 } })
})
type Output = { design: string; steps: { id: string; state: string; follows: unknown[] }[]; sizeMm: number[]; parts: { name: string; sizeMm: number[] }[] }
const call = async (method: string, args = {}) => (await runCall(method, args)) as { ok?: boolean; output: Output }

it('keeps both bodies and the target of a later edit when their creation order changes', async () => {
  const design = (await call('design.new', { name: 'Parts' })).output.design
  await call('geom.extrude', { design, name: 'Base', shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
  await call('geom.extrude', { design, name: 'Peg', shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, frame: { origin: [30, 0, 0], normal: [0, 0, 1] }, distance_mm: 2 })
  await call('geom.push_pull', { design, face: { at: [0, 0, 3], normal: [0, 0, 1] }, distance_mm: 2 })
  const before = (await call('design.steps', { design })).output
  const changed = await call('design.reorder_step', { design, step: 2, to: 1 })
  expect(changed.ok).toBe(true)
  expect(changed.output.parts).toHaveLength(2)
  expect(changed.output.sizeMm).toEqual(before.sizeMm)
  expect(changed.output.parts.find((p) => p.name === 'Base')!.sizeMm).toEqual([20, 10, 5])
  expect(changed.output.parts.find((p) => p.name === 'Peg')!.sizeMm).toEqual([4, 4, 2])
  expect((await call('design.steps', { design })).output.steps).toEqual(changed.output.steps)
})

it('reorders through the live methods, reports broken and skipped features, and refuses rollback edits', async () => {
  const design = (await call('design.new', { name: 'Boss' })).output.design
  await call('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
  await call('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 6, heightMm: 6 }, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, distance_mm: 4, operation: 'join' })
  await call('geom.push_pull', { design, face: { at: [0, 0, 7], normal: [0, 0, 1] }, distance_mm: 2 })
  const original = (await call('design.steps', { design })).output
  await call('design.undo', { design })
  await expect(call('design.reorder_step', { design, step: 1, to: 2 })).rejects.toThrow()
  await call('design.reorder_step', { design, step: 1, to: 1 })
  await call('design.redo', { design })
  expect((await call('design.steps', { design })).output.steps).toEqual(original.steps)
  set({ rollback: { marker: 1 } as never })
  await expect(call('design.reorder_step', { design, step: 3, to: 2 })).rejects.toMatchObject({ code: 'busy' })
  set({ rollback: null, historyEdit: { objectId: design } as never })
  await expect(call('design.reorder_step', { design, step: 3, to: 2 })).rejects.toMatchObject({ code: 'busy' })
  set({ historyEdit: null })
  const broken = await call('design.reorder_step', { design, step: 3, to: 2 })
  expect(broken.ok).toBe(false)
  expect(broken.output.steps.map((s) => s.state)).toEqual(['done', 'broken', 'skipped'])
  expect((await call('design.steps', { design })).output.steps).toEqual(broken.output.steps)
  const restored = await call('design.reorder_step', { design, step: original.steps[2]!.id, to: 3 })
  expect(restored.ok).toBe(true)
  expect(restored.output.sizeMm).toEqual(original.sizeMm)
  const entry = get().plate.find((e) => e.id === design)
  await expect(call('design.reorder_step', { design, step: 1, to: 3 })).rejects.toThrow()
  expect(get().plate.find((e) => e.id === design)).toBe(entry)
  const noOp = await call('design.reorder_step', { design, step: 1, to: 1 })
  expect(noOp.output.steps).toEqual(restored.output.steps)
  expect(get().plate.find((e) => e.id === design)).toBe(entry)
})
