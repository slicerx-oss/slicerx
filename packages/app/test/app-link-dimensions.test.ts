// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { beforeEach, expect, it, vi } from 'vitest'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { history } from '../src/plate/history'
import { toolStore } from '../src/plate/tools'
import { boxMesh, cylinderMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { liveEngine, useGeomEngine } from './geom-engine'

if (process.env['SX_TEST_GEOM_REQUIRE'] === '1' && !liveEngine) throw new Error('Build the real geometry WASM before running this suite')
useGeomEngine('app-dimensions')
vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000)
const test = it
const top = { object: 'box', part: 0, triangle: 2, at: [100, 100, 20] }
const bottom = { object: 'box', part: 0, triangle: 0, at: [100, 100, 0] }
const read = () => runCall('dimensions.list', {}) as Promise<import('@slicerx/mcp/toolset').AppDimensions>
const keep = (args = { kind: 'distance', a: top, b: bottom }) => runCall('dimensions.keep', args) as ReturnType<typeof read>
const block = (): PlateEntry => ({ id: 'box', name: 'Box', parts: [boxMesh(20, 20, 20)], handle: { id: 'box' } as MeshHandle, colors: ['#aaaaaa'], transform: compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
beforeEach(() => {
  toolStore.setState({ tool: 'move', moveArrows: false })
  set({ plate: [block()], activePlate: 'one', plates: [], selection: 'box', selectedIds: ['box'], showDimensions: false, workspace: 'prepare', modelMode: 'design', rollback: null, plateLoading: false, historyEdit: null, dragging: false, liveEdit: false, objectTool: null })
  history().clear()
})

test('keeps a measured distance, reads it independently, and restores it through Undo and Redo', async () => {
  expect(APP_LINK_METHODS['dimensions.keep']).toBe('edit')
  expect(APP_LINK_METHODS['dimensions.list']).toBe('read')
  const out = await keep()
  expect(out.kept).toBeTruthy()
  expect(out.dimensions[0]).toMatchObject({ id: out.kept, owner: { id: 'box', name: 'Box' }, kind: 'distance', status: 'ok', unit: 'mm', visible: true })
  expect(out.dimensions[0]!.value).toBeCloseTo(20)
  expect(out.dimensions[0]!.annotation?.label).toBe('20.00 mm')
  expect((await read()).dimensions).toEqual(out.dimensions)
  expect(history().state().undo).toBe(1)
  await runCall('history.undo', { revision: history().state().revision })
  expect((await read()).dimensions).toEqual([])
  await runCall('history.redo', { revision: history().state().revision })
  expect((await read()).dimensions[0]!.value).toBeCloseTo(20)
})

test('re-evaluates a scaled model instead of returning the old stored value', async () => {
  await keep()
  set({ plate: get().plate.map((e) => ({ ...e, transform: compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 2] }) })) })
  expect(get().plate[0]!.dimensions![0]!.value).toBeCloseTo(20)
  expect((await read()).dimensions[0]!.value).toBeCloseTo(40)
})

test('shows selected annotations or all annotations without making a history step, and removes with Undo', async () => {
  const kept = await keep()
  set({ selection: null, selectedIds: [] })
  expect((await read()).dimensions[0]!.visible).toBe(false)
  const revision = history().state().revision
  expect(await runCall('dimensions.show', { showAll: true })).toMatchObject({ showAll: true, dimensions: [{ visible: true }] })
  expect(history().state().revision).toBe(revision)
  await runCall('dimensions.show', { showAll: false })
  set({ selection: 'box', selectedIds: ['box'] })
  expect((await read()).dimensions[0]!.visible).toBe(true)
  expect(await runCall('dimensions.remove', { dimension: kept.kept })).toMatchObject({ removed: kept.kept, dimensions: [] })
  await runCall('history.undo', { revision: history().state().revision })
  expect((await read()).dimensions[0]!.id).toBe(kept.kept)
})

test('reports a lost endpoint with no stale value or visible mark', async () => {
  set({ plate: [...get().plate, { ...block(), id: 'other' }] })
  const out = await keep({ kind: 'distance', a: top, b: { ...bottom, object: 'other' } })
  set({ plate: get().plate.filter((e) => e.id !== 'other') })
  expect((await read()).dimensions[0]).toMatchObject({ id: out.kept, status: 'lost', value: null, visible: false, annotation: null })
})

test('keeps supported length and angle measurements from real features', async () => {
  const length = await runCall('dimensions.keep', { kind: 'length', a: { ...top, at: [110, 100, 20] } }) as Awaited<ReturnType<typeof read>>
  expect(length.dimensions[0]!.value).toBeCloseTo(20)
  const angle = await keep({ kind: 'angle', a: top, b: { ...bottom, triangle: 6, at: [110, 100, 10] } })
  expect(angle.dimensions.find((d) => d.id === angle.kept)).toMatchObject({ kind: 'angle', unit: 'deg' })
  expect(angle.dimensions.find((d) => d.id === angle.kept)!.value).toBeCloseTo(90)
})

test('keeps radius and diameter from a real cylindrical side', async () => {
  const part = cylinderMesh(20, 20)
  set({ plate: [{ ...block(), parts: [part] }] })
  // Use a triangle's own centroid, so the pick is on the faceted cylindrical side.
  const triangle = Array.from({ length: part.indices.length / 3 }, (_, i) => i).find((i) => {
    const z = Array.from({ length: 3 }, (_, k) => part.positions[part.indices[i * 3 + k]! * 3 + 2]!)
    return Math.min(...z) < Math.max(...z)
  })!
  const at = [0, 1, 2].map((axis) => [0, 1, 2].reduce((sum, k) => sum + part.positions[part.indices[triangle * 3 + k]! * 3 + axis]!, 0) / 3 + (axis < 2 ? 100 : 0))
  for (const kind of ['radius', 'diameter']) {
    const out = await runCall('dimensions.keep', { kind, a: { object: 'box', part: 0, triangle, at } }) as Awaited<ReturnType<typeof read>>
    expect(out.dimensions.find((d) => d.id === out.kept)!.value).toBeCloseTo(kind === 'radius' ? 10 : 20, 1)
  }
})

test('refuses malformed picks, unsupported features, locked objects and unfinished edits without a mutation', async () => {
  const before = get().plate
  for (const args of [
    { kind: 'distance', a: top }, { kind: 'length', a: top, b: bottom },
    { kind: 'distance', a: { ...top, triangle: 999 }, b: bottom },
    { kind: 'distance', a: top, b: bottom, value: 100 },
    { kind: 'diameter', a: top }, { kind: 'angle', a: top, b: bottom },
  ]) await expect(runCall('dimensions.keep', args)).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().plate).toBe(before)
  expect(history().state().undo).toBe(0)
  set({ plate: [{ ...before[0]!, locked: true }] })
  await expect(keep()).rejects.toMatchObject({ code: 'refused' })
  set({ plate: before, dragging: true })
  await expect(keep()).rejects.toMatchObject({ code: 'busy' })
  set({ dragging: false, objectTool: 'push' })
  await expect(keep()).rejects.toMatchObject({ code: 'busy' })
  set({ objectTool: null })
  toolStore.setState({ tool: 'paint' })
  await expect(keep()).rejects.toMatchObject({ code: 'busy' })
})
