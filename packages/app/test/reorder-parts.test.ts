// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import { IDENTITY, reorderedSteps, type History, type HistoryMesh, type ReplayResult, type Step, type StepParams } from '@slicerx/cad-history'

const mesh: HistoryMesh = { name: 'Part', slot: 1, positions: [], indices: [] }
const step = (id: string, part: number, params: StepParams): Step => ({ id, part, transform: [...IDENTITY], params })
const create = (id: string, part: number) => step(id, part, { op: 'shape.extrude', shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, spec: { distanceMm: 2, operation: 'new' } })
const edit = (id: string, part: number) => step(id, part, { op: 'face.push', at: [0, 0, 2], normal: [0, 0, 1], distanceMm: 1 })
const history = (...steps: Step[]): History => ({ version: 1, base: [mesh], steps })
const noSplit = async (): Promise<ReplayResult> => { throw new Error('No geometry inspection needed without a split') }

it('keeps added parts, Boolean operands and later targets on their original bodies', async () => {
  const h = history(step('add', -1, { op: 'parts.add', parts: [mesh, mesh], label: 'Two parts' }), create('new', 3), step('union', 0, { op: 'boolean', kind: 'union', with: [2] }), edit('edit', 2))
  const next = await reorderedSteps(h, 1, 0, noSplit)
  expect(next.map((s) => [s.id, s.part])).toEqual([['new', 1], ['add', -1], ['union', 0], ['edit', 1]])
  expect(next[2]!.params).toMatchObject({ with: [3] })
  expect(h.steps[2]!.params).toMatchObject({ with: [2] })
  const suppressed = { ...h, steps: h.steps.map((s, i) => i === 2 ? { ...s, suppressed: true } : i === 3 ? { ...s, part: 3 } : s) }
  const kept = await reorderedSteps(suppressed, 1, 0, noSplit)
  expect(kept[2]).toMatchObject({ suppressed: true, params: { with: [3] } })
  expect(kept[3]!.part).toBe(1)
})

it('keeps both sides of a cut and the appended body distinct', async () => {
  const cut = step('cut', 0, { op: 'plane.cut', plane: { point: [0, 0, 1], normal: [0, 0, 1] }, keep: 'both' })
  const h = history(cut, create('new', 2), edit('top', 1), edit('new-edit', 2))
  const next = await reorderedSteps(h, 1, 0, noSplit)
  expect(next.map((s) => [s.id, s.part])).toEqual([['new', 1], ['cut', 0], ['top', 1], ['new-edit', 2]])
})

it('uses the replayed split count when a reordered split creates more pieces', async () => {
  const split = step('split', 0, { op: 'split', buildVolumeMm: [10, 10, 10] })
  const h = history(split, create('new', 2), edit('new-edit', 2), edit('piece-edit', 1))
  const replay = async (h: History): Promise<ReplayResult> => ({ parts: Array.from({ length: h.steps[0]!.id === 'split' ? 2 : 4 }, () => mesh), status: h.steps.map(() => ({ state: 'done' })), moved: {} })
  const next = await reorderedSteps(h, 1, 0, replay)
  expect(next.map((s) => [s.id, s.part])).toEqual([['new', 1], ['split', 0], ['new-edit', 3], ['piece-edit', 1]])
})

it('refuses a missing split piece instead of retargeting a different body', async () => {
  const split = step('split', 0, { op: 'split', buildVolumeMm: [10, 10, 10] })
  const h = history(split, create('new', 3), edit('piece-edit', 2))
  const replay = async (h: History): Promise<ReplayResult> => ({ parts: Array.from({ length: 3 }, () => mesh), status: h.steps.map(() => ({ state: 'done' })), moved: {} })
  await expect(reorderedSteps(h, 1, 0, replay)).rejects.toThrow('part used by feature piece-edit does not exist')
})

it('refuses a feature moved ahead of its body, without changing the input', async () => {
  const h = { ...history(create('new', 0), edit('edit', 0)), base: [] }
  await expect(reorderedSteps(h, 1, 0, noSplit)).rejects.toThrow('creating feature before it')
  expect(h.steps.map((s) => [s.id, s.part])).toEqual([['new', 0], ['edit', 0]])
})
