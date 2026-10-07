// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The example plate is how a session starts, once. A plate the person emptied stays empty when the plate view opens
// again, and a design opened while the example loads lands alone.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const entry = (id: string): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(20, 20, 20), name: id }], colors: ['#bd93f9'], transform: compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const design = (name: string) => writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [entry(name)], settings: { sequence: 'by-layer' } }], bed: { widthMm: 256, depthMm: 256 }, settings: {}, sx: { exportedBy: '' } }).slice().buffer as ArrayBuffer

// The engine takes a moment to load the example's parts, as it does in the app.
let release: (() => void) | null = null
let slow = false
const host = {
  kind: 'web',
  capabilities: { threads: 1 },
  slicer: {
    loadParts: async (name: string) => {
      if (slow && name === 'Layered X') await new Promise<void>((r) => (release = r))
      return handle(name)
    },
  },
} as unknown as Host

// Each test is a new session: the module that remembers what this session opened starts over.
async function session() {
  vi.resetModules()
  const actions = await import('../src/state/actions')
  const store = await import('../src/state/store')
  const unsaved = await import('../src/project/unsaved')
  store.set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', selection: null, selectedIds: [], unsavedPrompt: null, plateLoading: false })
  unsaved.startDirtyTracking()
  unsaved.markClean()
  return { ...actions, names: () => store.get().plate.map((p) => p.name), set: store.set }
}

beforeEach(() => {
  slow = false
  release = null
})

describe('the example plate', () => {
  it('starts a session once; an emptied plate stays empty when the plate view opens again', async () => {
    const s = await session()
    await s.seedExamplePlate(host)
    expect(s.names()).toEqual(['Layered X'])
    s.set({ plate: [], selection: null, selectedIds: [] })
    await s.seedExamplePlate(host)
    expect(s.names()).toEqual([])
  })

  it('never comes back after a design was opened, and an opened design replaces it', async () => {
    const s = await session()
    await s.seedExamplePlate(host)
    await s.openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    expect(s.names()).toEqual(['tower'])
    s.set({ plate: [], selection: null, selectedIds: [] })
    await s.openModelBytes(host, 'clip.sx3mf', design('clip'), undefined, { fresh: true })
    await s.seedExamplePlate(host)
    expect(s.names()).toEqual(['clip'])
  })

  it('is dropped when a design opens while it loads', async () => {
    const s = await session()
    slow = true
    const seeding = s.seedExamplePlate(host)
    await vi.waitFor(() => expect(release).not.toBeNull())
    await s.openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    release!()
    await seeding
    expect(s.names()).toEqual(['tower'])
  })
})
