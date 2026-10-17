// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { keepDimension } from '../src/cad/dimensions'
import type { DimensionAnchor } from '../src/geom/cad'
import { setGeomProvider } from '../src/geom/client'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

const pending = { finish: undefined as undefined | ((value: { anchor: DimensionAnchor }) => void) }
afterEach(() => setGeomProvider(null))

const entry = (): PlateEntry => ({
  id: 'box', name: 'Box', handle: { id: 'box' } as MeshHandle,
  parts: [boxMesh(20, 20, 20)], colors: ['#aaaaaa'],
  transform: compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
})
const anchor: DimensionAnchor = { object: 'box', pick: { triangle: 2, at: [0, 0, 20] }, snapMm: 1.5, feature: { kind: 'edge', a: [-10, 0, 20], b: [10, 0, 20] } }
beforeEach(() => {
  pending.finish = undefined
  setGeomProvider({ call: <T>(op: string) => {
    if (op !== 'dimension.anchor') throw new Error(`Unexpected operation: ${op}`)
    return new Promise<T>((resolve) => { pending.finish = (value) => resolve(value as T) })
  } })
  set({ activePlate: 'one', plate: [entry()] })
})

for (const change of ['remove', 'replace', 'move', 'plate'] as const) {
  it(`refuses a kept dimension when ${change} changes its target during anchor loading`, async () => {
    const h = createHistory(appStore)
    try {
      const keeping = keepDimension('length', [{ objectId: 'box', partIndex: 0, triangle: 2, at: [100, 100, 20] }], 20)
      const outcome = keeping.then(() => null, (error: unknown) => error)
      expect(pending.finish).toBeDefined()
      if (change === 'remove') set({ plate: [] })
      if (change === 'replace') set({ plate: [entry()] })
      if (change === 'move') set({ plate: get().plate.map((e) => ({ ...e, transform: compose({ position: [200, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })) })
      if (change === 'plate') set({ activePlate: 'two' })
      const before = get().plate
      const revision = h.state().revision
      pending.finish!({ anchor })
      expect(await outcome).toBeInstanceOf(Error)
      expect(get().plate).toBe(before)
      expect(h.state().revision).toBe(revision)
    } finally { h.dispose() }
  })
}
