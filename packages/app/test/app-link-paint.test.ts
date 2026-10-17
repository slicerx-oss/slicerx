// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { runCall } from '../src/app-link/methods'
import { setGeomProvider } from '../src/geom/client'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { commitStroke } from '../src/plate/paint'
import { paintedParts } from '../src/plate/painted'
import { toolStore } from '../src/plate/tools'
import { identity } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const entry = (id: string): PlateEntry => ({ id, name: 'Box', handle: { id, parts: [] } as unknown as MeshHandle, parts: [boxMesh(10, 10, 10), boxMesh(5, 5, 5)], colors: ['#fff'], transform: identity() })
const client = { id: 'client', name: 'Test client' }
const call = (method: string, args: Record<string, unknown> = {}) => runCall(`paint.${method}`, args, client) as Promise<{ output: { preview: string; revision: string; changed: boolean; parts: { states: { state: number }[] }[] } }>
const read = (layer = 'color') => call('get', { object: 'body', layer })
const preview = (args = {}) => call('preview', { object: 'body', layer: 'color', state: 1, target: { kind: 'part' }, ...args })
const engine = vi.fn(async (op: string, args: unknown) => {
  const q = args as { state: number; paint: Record<string, string> }
  return op === 'paint.select' ? { changed: { 0: q.state ? String(q.state * 4) : '' }, selectedAreaMm2: 10 } : { states: Object.values(q.paint).map((text) => ({ state: Number(text) / 4, areaMm2: 10, triangles: 1, regionCount: 1, regions: [] })) }
})
beforeEach(() => {
  set({ plate: [entry('body'), { ...entry('copy'), instanceOf: 'body' }], plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], activePlate: 'shown', objectSettings: {}, slotSetup: {}, overrides: {}, plateLoading: false, rollback: null, historyEdit: null, liveEdit: false, objectTool: null, dragging: false, slice: { status: 'idle' } })
  toolStore.setState({ tool: 'move' })
  history().clear()
  engine.mockClear()
  setGeomProvider({ call: engine as never })
})
afterEach(() => setGeomProvider(null))

it('previews without edits, applies all parts as one Undo step and reads the engine paint', async () => {
  const pv = await preview()
  expect(get().plate[0]!.paint).toBeUndefined()
  expect(history().state().undo).toBe(0)
  const applied = await call('apply', { preview: pv.output.preview })
  expect(applied.output.parts).toEqual(pv.output.parts)
  expect((await read()).output.parts).toEqual(applied.output.parts)
  expect(paintedParts(get().plate[0]!)[0]!.paint).toEqual({ color: { 0: '4' } })
  expect(get().plate[1]!.paint).toBeUndefined()
  expect(history().state().undo).toBe(1)
  history().undo()
  expect((await read()).output.parts.every((p) => p.states.length === 0)).toBe(true)
  history().redo()
  expect((await read()).output.parts).toEqual(applied.output.parts)
})

it('keeps fuzzy activation with the paint in one Undo step', async () => {
  const pv = await preview({ layer: 'fuzzy' })
  await call('apply', { preview: pv.output.preview })
  expect(get().objectSettings['body']).toEqual({ fuzzy_skin: 'none' })
  expect(history().state().undo).toBe(1)
  history().undo()
  expect(get().objectSettings['body']).toBeUndefined()
  expect(get().plate[0]!.paint).toBeUndefined()
})

it('reads brush paint, clears only the chosen layer and keeps no-ops out of Undo', async () => {
  for (const layer of ['color', 'seam'] as const) commitStroke({ objectId: 'body', partIndex: 0, layer, edits: [{ triangle: 0, after: '4' }] })
  expect((await read()).output.parts[0]!.states).toHaveLength(1)
  const before = (await read()).output
  await call('clear', { object: 'body', layer: 'color', revision: before.revision })
  expect(get().plate[0]!.paint).toEqual({ 0: { seam: { 0: '4' } } })
  const now = (await read()).output
  expect((await call('clear', { object: 'body', layer: 'color', revision: now.revision })).output).toMatchObject({ changed: false, revision: now.revision })
  const pv = await preview({ state: 0 })
  expect((await call('apply', { preview: pv.output.preview })).output).toMatchObject({ changed: false, revision: now.revision })
  history().undo()
  expect((await read()).output.parts).toEqual(before.parts)
})

it('binds a preview to its client, consumes it once and refuses stale state', async () => {
  const pv = (await preview()).output.preview
  await expect(runCall('paint.apply', { preview: pv }, { id: 'another', name: 'Other' })).rejects.toMatchObject({ code: 'not_found' })
  await call('apply', { preview: pv })
  await expect(call('apply', { preview: pv })).rejects.toMatchObject({ code: 'not_found' })
  const stale = (await preview()).output.preview
  set({ plate: [...get().plate] })
  await expect(call('apply', { preview: stale })).rejects.toMatchObject({ code: 'busy' })
})

it('rejects a plate switch even when the history revision is unchanged', async () => {
  const pv = (await preview()).output.preview
  set({ activePlate: 'other' })
  await expect(call('apply', { preview: pv })).rejects.toMatchObject({ code: 'busy' })
})

it('refuses locked objects, active tools and invalid targets without editing', async () => {
  for (const bad of [{ state: 2 }, { layer: 'support', state: 3 }, { layer: 'fuzzy', state: 2 }, { part: 2 }, { target: { kind: 'seed', point: [0, 0, 0] } }, { target: { kind: 'height', below: 2, above: 1 } }, { target: { kind: 'direction', direction: [NaN, 0, 0] } }]) await expect(preview(bad)).rejects.toMatchObject({ code: 'invalid_input' })
  set({ plate: [{ ...get().plate[0]!, locked: true }] })
  const pv = (await preview()).output.preview
  await expect(call('apply', { preview: pv })).rejects.toMatchObject({ code: 'refused' })
  set({ plate: [{ ...get().plate[0]!, locked: false }] })
  const next = (await preview()).output.preview
  toolStore.setState({ tool: 'paint' })
  await expect(call('apply', { preview: next })).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate[0]!.paint).toBeUndefined()
})

it('rejects changes during asynchronous geometry selection', async () => {
  engine.mockImplementationOnce(async () => { set({ plate: [...get().plate] }); return { changed: { 0: '4' }, selectedAreaMm2: 10 } })
  await expect(preview()).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate[0]!.paint).toBeUndefined()
})

it('preserves a locked copy when fuzzy painting would change its shared setting', async () => {
  set({ plate: [get().plate[0]!, { ...get().plate[1]!, locked: true }] })
  const pv = (await preview({ layer: 'fuzzy' })).output.preview
  await expect(call('apply', { preview: pv })).rejects.toMatchObject({ code: 'refused' })
  expect(get().objectSettings).toEqual({})
  expect(get().plate[0]!.paint).toBeUndefined()
  expect(history().state().undo).toBe(1)
})

it.each(['object', 'global'] as const)('paints an unlocked object when the shared fuzzy setting is already enabled by %s', async (scope) => {
  set({ plate: [get().plate[0]!, { ...get().plate[1]!, locked: true }] })
  if (scope === 'object') set({ objectSettings: { body: { fuzzy_skin: 'none' } } })
  else set({ overrides: { fuzzy_skin: 'none' } })
  history().clear()
  const settings = get().objectSettings
  const pv = (await preview({ layer: 'fuzzy' })).output.preview
  expect((await call('apply', { preview: pv })).output.changed).toBe(true)
  expect(get().plate[0]!.paint?.[0]?.fuzzy).toEqual({ 0: '4' })
  expect(get().plate[1]).toMatchObject({ locked: true })
  expect(get().plate[1]!.paint).toBeUndefined()
  expect(get().objectSettings).toEqual(settings)
  expect(history().state().undo).toBe(1)
  history().undo()
  expect(get().plate[0]!.paint).toBeUndefined()
  expect(get().objectSettings).toEqual(settings)
})
