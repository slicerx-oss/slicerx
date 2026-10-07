// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a design (a file, a Vault design, a recent project) starts a new project: the old plate goes, after asking
// once when there is unsaved work. Add model keeps what is on the plate. (Fit markers follow the plate: e2e/fit-check.)
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { answerUnsaved, isDirty, markClean, startDirtyTracking } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const entry = (id: string, x = 60): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(20, 20, 20), name: id }], colors: ['#bd93f9'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host
const design = (name: string) => writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [entry(name, 128)], settings: { sequence: 'by-layer' } }], bed: { widthMm: 256, depthMm: 256 }, settings: {}, sx: { exportedBy: '' } }).slice().buffer as ArrayBuffer

beforeEach(() => {
  set({ plate: [entry('a'), entry('b', 100)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', selection: null, selectedIds: [], unsavedPrompt: null })
  startDirtyTracking()
  markClean()
})

const names = () => get().plate.map((p) => p.name)

describe('opening a design', () => {
  it('starts a new project, every time', async () => {
    await openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    expect(names()).toEqual(['tower'])
    // A second and a third open each replace the plate, never stack.
    await openModelBytes(host, 'cube.sx3mf', design('cube'), undefined, { fresh: true })
    await openModelBytes(host, 'clip.sx3mf', design('clip'), undefined, { fresh: true })
    expect(names()).toEqual(['clip'])
    expect(isDirty()).toBe(false)
  })

  it('asks once when there is unsaved work: Cancel keeps the plate, Discard opens', async () => {
    set((s) => ({ plate: [...s.plate, entry('c', 140)] }))
    expect(isDirty()).toBe(true)
    const canceled = openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    await vi.waitFor(() => expect(get().unsavedPrompt).toEqual({ what: 'open another design' }))
    answerUnsaved(false)
    await canceled
    expect(names()).toEqual(['a', 'b', 'c'])
    const discarded = openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    await vi.waitFor(() => expect(get().unsavedPrompt).not.toBeNull())
    answerUnsaved(true)
    await discarded
    expect(names()).toEqual(['tower'])
  })

  it('adds to the plate only when asked to', async () => {
    await openModelBytes(host, 'tower.sx3mf', design('tower'))
    expect(names()).toEqual(['a', 'b', 'tower'])
  })
})
