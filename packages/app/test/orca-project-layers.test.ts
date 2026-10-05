// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An Orca or Bambu Studio project opens with sleipnir off, so its layers match the slicer that made it;
// our own .sx3mf keeps what the person had.
import type { Host, MeshHandle } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { openModelBytes } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host

function projectBytes(): ArrayBuffer {
  const e: PlateEntry = { id: 'obj_a', name: 'Cube', handle: handle('a'), parts: [{ ...boxMesh(20, 20, 20), name: 'body', slot: 1 }], colors: ['#f2754e'], transform: compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
  const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-layer' } }], bed, settings: {} })
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('sleipnir on opening a project', () => {
  beforeEach(() => set((s) => ({ plate: [], plates: s.plates.map((p) => ({ ...p, objects: [] })), easy: { ...s.easy, varyLayerHeight: true } })))

  it('an Orca or Bambu project turns it off', async () => {
    await openModelBytes(host, 'benchy.3mf', projectBytes())
    expect(get().plate.length).toBe(1)
    expect(get().easy.varyLayerHeight).toBe(false)
  })

  it('our own .sx3mf leaves it as it was', async () => {
    await openModelBytes(host, 'bracket.sx3mf', projectBytes())
    expect(get().plate.length).toBe(1)
    expect(get().easy.varyLayerHeight).toBe(true)
  })
})
