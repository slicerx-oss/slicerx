// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, expect, it } from 'vitest'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { currentEdition, setCurrentEdition } from '../src/edition'
import { history } from '../src/plate/history'
import { setPickKind } from '../src/plate/sub-pick'
import { toolStore } from '../src/plate/tools'
import { get, set, type SubPick } from '../src/state/store'

const originalEdition = currentEdition()
const face: SubPick = { kind: 'face', objectId: 'a', partIndex: 1, triangle: 7, point: [1.234, 2, 3] }
const edge: SubPick = { kind: 'edge', objectId: 'a', partIndex: 1, triangle: 8, point: [1, 2, 3], round: true }
const read = () => runCall('select.filter', {})
const change = (args: Record<string, unknown>) => runCall('select.filter_set', args)
beforeEach(() => {
  setCurrentEdition({ ...originalEdition, features: { ...originalEdition.features, cad: true } })
  set({ workspace: 'prepare', modelMode: 'design', objectTool: null, pickFilter: ['face', 'edge'], subPicks: [face, edge], selection: 'a', selectedIds: ['a'] })
  toolStore.setState({ tool: 'select' })
})
afterEach(() => { setCurrentEdition(originalEdition); set({ subPicks: [], selection: null, selectedIds: [], pickFilter: ['face'], objectTool: null }); toolStore.setState({ tool: 'select' }) })

it('shares the UI filter command, drops excluded picks and independently reads the resulting selection', async () => {
  expect(APP_LINK_METHODS['select.filter']).toBe('read')
  expect(APP_LINK_METHODS['select.filter_set']).toBe('read')
  const revision = history().state().revision
  expect(await read()).toMatchObject({ available: true, pickFilter: ['face', 'edge'], primary: 'a', picks: [{ kind: 'face', pointMm: [1.23, 2, 3] }, { kind: 'edge', round: true }] })
  const changed = await change({ kind: 'face' })
  expect(changed).toMatchObject({ pickFilter: ['face'], primary: 'a', picks: [{ kind: 'face' }] })
  expect(get().subPicks).toEqual([face])
  expect(await read()).toEqual(changed)
  setPickKind('object', 'only')
  expect(await read()).toMatchObject({ pickFilter: ['object'], primary: 'a', picks: [] })
  expect(history().state().revision).toBe(revision)
})

it('keeps canonical kind order and never leaves an empty filter when toggling', async () => {
  await change({ kind: 'object', mode: 'toggle' })
  expect(await read()).toMatchObject({ pickFilter: ['object', 'face', 'edge'] })
  await change({ kind: 'object', mode: 'only' })
  await change({ kind: 'object', mode: 'toggle' })
  expect(await read()).toMatchObject({ pickFilter: ['object'] })
})

it('accepts the default move tool without arrows as ordinary Model selection', async () => {
  toolStore.setState({ tool: 'move', moveArrows: false })
  expect(await read()).toMatchObject({ available: true })
  expect(await change({ kind: 'edge' })).toMatchObject({ available: true, pickFilter: ['edge'] })
})

it('rejects malformed requests without changing the filter or picks', async () => {
  const before = await read()
  for (const args of [{}, { kind: 'body' }, { kind: 'edge', mode: null }, { kind: 'edge', mode: 'add' }, { kind: 'face', unknown: true }]) {
    await expect(change(args)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await read()).toEqual(before)
  }
})

it('reads while unavailable but refuses changes in Slice, other workspaces, editions and active tools', async () => {
  for (const state of [{ modelMode: 'slice' as const }, { workspace: 'library' as const }, { objectTool: 'sketch' as const }]) {
    const before = get()
    set(state)
    expect(await read()).toMatchObject({ available: false })
    await expect(change({ kind: 'object' })).rejects.toMatchObject({ code: 'busy' })
    expect(get().pickFilter).toEqual(['face', 'edge'])
    set(before)
  }
  toolStore.setState({ tool: 'move', moveArrows: true })
  await expect(change({ kind: 'object' })).rejects.toMatchObject({ code: 'busy' })
  toolStore.setState({ tool: 'select' })
  setCurrentEdition({ ...originalEdition, features: { ...originalEdition.features, cad: false } })
  await expect(change({ kind: 'object' })).rejects.toMatchObject({ code: 'busy' })
})
