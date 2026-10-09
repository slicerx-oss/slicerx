// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir is on for a fresh plate and a new user; a saved choice of off stays off; an opened Orca or Bambu Studio
// project prints its own fixed layers, and the next fresh plate has sleipnir back.
import type { Host, MeshHandle } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { writeProject } from '../src/export/threemf'
import { freshVary } from '../src/lib/sleipnir-default'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { clearProject } from '../src/project/new'
import { openModelBytes } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'

const initial = get()
const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host

function projectBytes(): ArrayBuffer {
  const e: PlateEntry = { id: 'obj_a', name: 'Cube', handle: handle('a'), parts: [{ ...boxMesh(20, 20, 20), name: 'body', slot: 1 }], colors: ['#f2754e'], transform: compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
  const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-layer' } }], bed, settings: {} })
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('sleipnir on a fresh plate', () => {
  beforeEach(() => set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], easy: { ...initial.easy }, easyTouched: [], goal: 'standard' }))

  it('is on for a new user and a fresh plate', () => {
    // No saved prefs in the test run: the store starts as a new user's would.
    expect(initial.easy.varyLayerHeight).toBe(true)
    expect(freshVary({ easy: { varyLayerHeight: false }, easyTouched: [], goal: 'standard' })).toBe(true)
    expect(freshVary({ easy: { varyLayerHeight: false }, easyTouched: [], goal: 'custom' })).toBe(true)
    set({ easy: { ...get().easy, varyLayerHeight: false }, goal: 'custom' })
    clearProject()
    expect(get().easy.varyLayerHeight).toBe(true)
  })

  it('stays off when the person turned it off, and with the Draft goal', () => {
    set({ easy: { ...get().easy, varyLayerHeight: false }, easyTouched: ['varyLayerHeight'], goal: 'custom' })
    clearProject()
    expect(get().easy.varyLayerHeight).toBe(false)
    expect(freshVary({ easy: { varyLayerHeight: false }, easyTouched: ['varyLayerHeight'], goal: 'standard' })).toBe(false)
    expect(freshVary({ easy: { varyLayerHeight: true }, easyTouched: [], goal: 'draft' })).toBe(false)
  })

  it('goes off for an opened Bambu Studio project, and comes back on for the next fresh plate', async () => {
    await openModelBytes(host, 'benchy.3mf', projectBytes())
    expect(get().plate.length).toBe(1)
    expect(get().easy.varyLayerHeight).toBe(false)
    expect(get().easyTouched).not.toContain('varyLayerHeight')
    clearProject()
    expect(get().easy.varyLayerHeight).toBe(true)
  })
})
