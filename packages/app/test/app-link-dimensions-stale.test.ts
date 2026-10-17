// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { keep, readDimensions, show } from '../src/app-link/dimensions'
import type { Dimension, EvaluatedDimension } from '../src/geom/cad'
import { setGeomProvider } from '../src/geom/client'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { history } from '../src/plate/history'
import { toolStore } from '../src/plate/tools'
import { get, set } from '../src/state/store'

const pending = { finish: undefined as undefined | ((value: EvaluatedDimension[]) => void) }
afterEach(() => setGeomProvider(null))

const d: Dimension = { id: 'kept', kind: 'length', a: { object: 'box', pick: { triangle: 2, at: [0, 0, 20] }, snapMm: 1.5, feature: { kind: 'edge', a: [-10, 0, 20], b: [10, 0, 20] } } }
beforeEach(() => {
  pending.finish = undefined
  setGeomProvider({ call: <T>(op: string) => {
    if (op !== 'dimension.evaluate') throw new Error(`Unexpected operation: ${op}`)
    return new Promise<T>((resolve) => { pending.finish = (dimensions) => resolve({ dimensions } as T) })
  } })
  set({ activePlate: 'one', plateLoading: false, showDimensions: false, plate: [{ id: 'box', name: 'Box', handle: { id: 'box' } as MeshHandle, parts: [boxMesh(20, 20, 20)], colors: ['#aaaaaa'], transform: compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), dimensions: [d] }] })
})

for (const operation of ['read', 'show'] as const) {
  it(`refuses a stale ${operation} after an asynchronous measurement without changing visibility`, async () => {
    const work = operation === 'read' ? readDimensions({}) : show({ showAll: true })
    const failure = expect(work).rejects.toMatchObject({ code: 'busy' })
    expect(pending.finish).toBeDefined()
    set({ plate: [] })
    pending.finish!([{ id: d.id, status: 'ok', value: 20, unit: 'mm', changed: false, a: d.a }])
    await failure
    expect(get().showDimensions).toBe(false)
    expect(get().plate).toEqual([])
  })
}

it('refuses a keep when an edit starts while its anchor is loading', async () => {
  toolStore.setState({ tool: 'move', moveArrows: false })
  set({ workspace: 'prepare', rollback: null, dragging: false, liveEdit: false, objectTool: null, historyEdit: null })
  history().clear()
  let finish: (() => void) | undefined
  setGeomProvider({ call: <T>(op: string) => {
    if (op === 'measure.feature') return Promise.resolve({ feature: d.a.feature } as T)
    if (op === 'measure') return Promise.resolve({ lengthMm: 20 } as T)
    if (op === 'dimension.anchor') return new Promise<T>((resolve) => { finish = () => resolve({ anchor: d.a } as T) })
    throw new Error(`Unexpected operation: ${op}`)
  } })
  const work = keep({ kind: 'length', a: { object: 'box', part: 0, triangle: 2, at: [0, 0, 20] } }, 'Client')
  const failure = expect(work).rejects.toMatchObject({ code: 'busy' })
  await expect.poll(() => finish !== undefined).toBe(true)
  const before = get().plate
  const revision = history().state().revision
  set({ dragging: true })
  finish!()
  await failure
  expect(get().plate).toBe(before)
  expect(history().state().revision).toBe(revision)
})
