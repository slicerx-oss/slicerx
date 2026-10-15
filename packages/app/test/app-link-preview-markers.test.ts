// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { history } from '../src/plate/history'
import { toolStore } from '../src/plate/tools'
import { get, set } from '../src/state/store'
import { MARKERS, markerView, setMarkerShown } from '../src/workspaces/preview/markers'

beforeEach(() => {
  set({ workspace: 'prepare', modelMode: 'slice', sliceLook: 'toolpaths', preview: { extrasOffset: 0, layerCount: 10 } as never })
  toolStore.setState({ tool: 'select' })
  markerView.setState({ shown: Object.fromEntries(MARKERS.map((m) => [m.kind, false])) as ReturnType<typeof markerView.getState>['shown'], counts: {}, countsFor: null })
})
const call = (method: string, args = {}) => runCall(`preview.${method}`, args)

it('reads UI switches and later counts without treating an unknown count as zero', async () => {
  setMarkerShown('wipes', true)
  const before = await call('markers') as { markers: { kind: string; shown: boolean; count?: number }[] }
  expect(before.markers.find((m) => m.kind === 'wipes')).toMatchObject({ shown: true })
  expect(before.markers.find((m) => m.kind === 'wipes')).not.toHaveProperty('count')
  markerView.setState({ countsFor: get().preview, counts: { wipes: 0, toolChanges: 2 } })
  expect(await call('markers')).toMatchObject({ markers: expect.arrayContaining([{ kind: 'wipes', label: 'Wipes', shown: true, available: true, source: 'gcode', count: 0 }]) })
  expect(before.markers.find((m) => m.kind === 'wipes')).not.toHaveProperty('count')
})

it('changes all six legend switches with read grants and no project history edit', async () => {
  expect(APP_LINK_METHODS['preview.markers']).toBe('read')
  expect(APP_LINK_METHODS['preview.markers_set']).toBe('read')
  const revision = history().state().revision
  await call('markers_set', Object.fromEntries(MARKERS.map((m) => [m.kind, true])))
  expect(Object.values(markerView.getState().shown)).toEqual(Array(6).fill(true))
  await call('markers_set', { seams: false })
  expect(markerView.getState().shown).toMatchObject({ seams: false, retractions: true, pauses: true })
  expect(history().state().revision).toBe(revision)
})

it('does not return counts from a replaced preview before the viewport has refreshed them', async () => {
  markerView.setState({ countsFor: get().preview, counts: { wipes: 9 } })
  set({ preview: { ...get().preview!, layerCount: 12 } })
  const result = await call('markers') as { markers: { count?: number }[] }
  for (const row of result.markers) expect(row).not.toHaveProperty('count')
})

it('refuses invalid batches, unavailable markers, missing previews and active tools atomically', async () => {
  const untouched = markerView.getState().shown
  for (const args of [{}, { wipes: true, seams: 'yes' }, { wipes: true, unknown: false }]) {
    await expect(call('markers_set', args)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(markerView.getState().shown).toEqual(untouched)
  }
  set({ preview: { ...get().preview!, extrasOffset: -1 } })
  await expect(call('markers_set', { wipes: true, seams: true })).rejects.toMatchObject({ code: 'refused' })
  expect(markerView.getState().shown).toEqual(untouched)
  await call('markers_set', { seams: false })
  set({ preview: null })
  await expect(call('markers_set', { wipes: true })).rejects.toMatchObject({ code: 'not_ready' })
  expect(await call('markers')).toMatchObject({ sliced: false, markers: expect.arrayContaining([expect.objectContaining({ kind: 'wipes', available: false })]) })
  set({ modelMode: 'design' })
  await expect(call('markers_set', { wipes: true })).rejects.toMatchObject({ code: 'busy' })
  set({ modelMode: 'slice', preview: { extrasOffset: 0 } as never })
  toolStore.setState({ tool: 'paint' })
  await expect(call('markers_set', { wipes: true })).rejects.toMatchObject({ code: 'busy' })
  expect(markerView.getState().shown).toEqual(untouched)
})
