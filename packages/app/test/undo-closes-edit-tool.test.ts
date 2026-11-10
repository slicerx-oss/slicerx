// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Undo or redo while a history step is open for editing closes the step and the tool it opened. The tool's panel is
// keyed to the step, so a tool left open would mount again with nothing to edit: the sketch tool came back as
// "No plane yet".
import type { MeshHandle } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createHistory } from '../src/plate/history'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const entry = (id: string, name: string): PlateEntry => ({ id, name, handle: handle(id), parts: [], colors: ['#bd93f9'], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as unknown as PlateEntry

describe('undo with a step open for editing', () => {
  for (const way of ['undo', 'redo'] as const) {
    it(`closes the step's tool on ${way}`, () => {
      const a = entry('a', 'Bracket')
      set({ plate: [a], selection: 'a', selectedIds: ['a'], historyEdit: null, objectTool: null })
      const h = createHistory(appStore)
      try {
        set({ plate: [a, entry('b', 'Peg')] })
        if (way === 'redo') h.undo()
        // An extrude step opened for editing, as beginEdit leaves it: the object rolled back, the sketch tool open.
        set({ historyEdit: { objectId: 'a', index: 0, original: a }, objectTool: 'sketch' })
        expect(h[way]()).toBe(true)
        expect(get().historyEdit).toBeNull()
        expect(get().objectTool).toBeNull()
      } finally {
        h.dispose()
      }
    })
  }

  it('leaves an open tool alone when no step is open', () => {
    const a = entry('a', 'Bracket')
    set({ plate: [a], selection: 'a', selectedIds: ['a'], historyEdit: null, objectTool: null })
    const h = createHistory(appStore)
    try {
      set({ plate: [a, entry('b', 'Peg')] })
      set({ objectTool: 'sketch' })
      h.undo()
      expect(get().objectTool).toBe('sketch')
    } finally {
      h.dispose()
    }
  })
})
