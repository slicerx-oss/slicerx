// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An opened Orca or Bambu Studio project turns sleipnir off for that project only, also while profile sync follows the store.
// Profile sync subscribes to the store for the rest of the module's life and has no way to stop, so this runs in a file of its own:
// beside the tests of sleipnir-default.test.ts it marked every later change to the layer height as the person's choice.
import type { Host, MeshHandle } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { clearProject } from '../src/project/new'
import { openModelBytes } from '../src/state/actions'
import { startProfileSync } from '../src/state/profile-sync'
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

describe('sleipnir on a fresh plate, with profile sync following the store', () => {
  beforeEach(() => set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], easy: { ...initial.easy }, easyTouched: [], goal: 'standard' }))

  it("is not marked as the person's choice by an opened project while the app follows the store", async () => {
    // In the app, profile sync watches the store and marks every Easy control a change moves. The project turning
    // sleipnir off must not count as a move, or the saved list keeps it off on every fresh plate and every start.
    startProfileSync()
    await openModelBytes(host, 'benchy.3mf', projectBytes())
    expect(get().easy.varyLayerHeight).toBe(false)
    expect(get().easyTouched).not.toContain('varyLayerHeight')
    clearProject()
    expect(get().easy.varyLayerHeight).toBe(true)
  })
})
