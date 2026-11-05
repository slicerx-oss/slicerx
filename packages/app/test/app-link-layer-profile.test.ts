// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads, sets and resets a plate's own layer heights through the app link: read back, one Undo step each,
// heights the printer does not print refused.
import { beforeEach, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { runCall } from '../src/app-link/methods'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { toolStore } from '../src/plate/tools'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const entry = (id: string): PlateEntry => ({
  id, name: 'Box', handle: { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] } as MeshHandle,
  parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'],
  transform: compose({ position: [50, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
})
const client = { id: 'client', name: 'Test client' }
type Out = { summary: string; output: { mode: string; profile: number[][] | null; limits: { min_mm: number; max_mm: number; first_layer_mm: number }; top_mm: number; layers?: number; plate: { number: number; id: string; shown: boolean }; changed?: boolean } }
const read = (args: Record<string, unknown> = {}) => runCall('layers.profile.get', args, client) as Promise<Out>
const edit = (args: Record<string, unknown>) => runCall('layers.profile.edit', args, client) as Promise<Out>

beforeEach(() => {
  set({ plate: [entry('body')], plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }, { id: 'other', name: 'Other', objects: [], settings: {} }], activePlate: 'shown', overrides: { min_layer_height: [0.08], max_layer_height: [0.28], initial_layer_print_height: 0.2 }, easy: { ...get().easy, varyLayerHeight: false }, plateLoading: false, historyEdit: null, liveEdit: false, dragging: false, slice: { status: 'idle' } })
  toolStore.setState({ tool: 'move' })
  history().clear()
})

it('reads a plate without its own layer heights as fixed, with the printer limits and the plate top', async () => {
  const r = await read()
  expect(r.output).toMatchObject({ mode: 'fixed', profile: null, limits: { min_mm: 0.08, max_mm: 0.28, first_layer_mm: 0.2 }, top_mm: 10, plate: { number: 1, id: 'shown', shown: true } })
  expect(r.summary).toMatch(/^Plate 1 slices with a fixed [\d.]+ mm layer height\.$/)
})

it('sets the profile, reads it back with its layer count, and takes it back with one Undo', async () => {
  const r = await edit({ action: 'set', points: [[5, 0.24], [1, 0.12]] })
  expect(r.output).toMatchObject({ mode: 'own', profile: [[1, 0.12], [5, 0.24]], changed: true })
  expect(r.output.layers).toBeGreaterThan(40)
  expect(r.summary).toMatch(/^Plate 1 slices with its own layer heights, \d+ layers\.$/)
  expect(get().plates[0]!.settings.layerProfile).toEqual([[1, 0.12], [5, 0.24]])
  expect(history().undo()).toBe(true)
  expect(get().plates[0]!.settings.layerProfile).toBeUndefined()
})

it('resets, and a reset with nothing to clear changes nothing', async () => {
  await edit({ action: 'set', points: [[1, 0.12]] })
  expect((await edit({ action: 'reset' })).output).toMatchObject({ mode: 'fixed', profile: null, changed: true })
  expect((await edit({ action: 'reset' })).output.changed).toBe(false)
})

it('works on another plate by number, leaving the shown one alone', async () => {
  const r = await edit({ plate: 2, action: 'set', points: [[0, 0.2]] })
  expect(r.output.plate).toMatchObject({ number: 2, id: 'other', shown: false })
  expect(get().plates[0]!.settings.layerProfile).toBeUndefined()
  expect(get().plates[1]!.settings.layerProfile).toEqual([[0, 0.2]])
})

it('refuses heights outside the printer limits, bad input, missing plates and a busy app, changing nothing', async () => {
  await expect(edit({ action: 'set', points: [[0, 0.3]] })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/0\.08 to 0\.28 mm/) })
  await expect(edit({ action: 'set' })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(edit({ action: 'reset', points: [[0, 0.2]] })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(edit({ plate: 9, action: 'reset' })).rejects.toMatchObject({ code: 'not_found' })
  set({ plateLoading: true })
  await expect(edit({ action: 'set', points: [[0, 0.2]] })).rejects.toMatchObject({ code: 'busy' })
  expect(get().plates.every((p) => p.settings.layerProfile === undefined)).toBe(true)
})

it('keeps the profile when a client replaces the plate settings', async () => {
  await edit({ action: 'set', points: [[1, 0.12]] })
  set({ workspace: 'prepare', modelMode: 'slice', objectTool: null })
  await runCall('plates.settings', { plate: 1, settings: {}, replace: true }, client)
  expect(get().plates[0]!.settings).toEqual({ layerProfile: [[1, 0.12]] })
})
