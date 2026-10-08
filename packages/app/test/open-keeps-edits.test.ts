// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An open marks the project clean when it finishes, but only for its own changes: an edit made while it runs (a model
// dropped as the opened objects appear, before its settings are applied) keeps the project unsaved, and the next open
// asks first.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { answerUnsaved, beginOpen, isDirty, markClean, startDirtyTracking, withoutDirtying } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const entry = (id: string, x = 60): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(20, 20, 20), name: id }], colors: ['#bd93f9'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host
const design = (name: string, settings: Record<string, unknown> = {}) =>
  writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [entry(name, 128)], settings: { sequence: 'by-layer' } }], bed: { widthMm: 256, depthMm: 256 }, settings }).slice().buffer as ArrayBuffer

const names = () => get().plate.map((p) => p.name)

beforeEach(() => {
  set({ plate: [entry('a')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', selection: null, selectedIds: [], unsavedPrompt: null, overrides: {} })
  startDirtyTracking()
  markClean()
})

/** Drops a cube onto the plate as soon as `name`'s objects appear, between the open's own steps. */
function dropCubeWhenShown(name: string): void {
  const stop = appStore.subscribe((s) => {
    if (!s.plate.some((p) => p.name === name)) return
    stop()
    queueMicrotask(() => set((st) => ({ plate: [...st.plate, entry('cube', 30)] })))
  })
}

describe('an open and the edits made while it runs', () => {
  it('a cube dropped while a project opens keeps the project unsaved, and the next open asks', async () => {
    dropCubeWhenShown('tower')
    // A project with print settings: they are applied after its objects appear.
    await openModelBytes(host, 'tower.3mf', design('tower', { layer_height: '0.16', wall_loops: '3' }), undefined, { fresh: true })
    expect(names()).toEqual(['tower', 'cube'])
    expect(isDirty()).toBe(true)
    const next = openModelBytes(host, 'clip.3mf', design('clip'), undefined, { fresh: true })
    await vi.waitFor(() => expect(get().unsavedPrompt).toEqual({ what: 'open another design' }))
    answerUnsaved(false)
    await next
    expect(names()).toEqual(['tower', 'cube'])
  })

  it('an open on its own still ends clean', async () => {
    await openModelBytes(host, 'tower.3mf', design('tower', { layer_height: '0.16', wall_loops: '3' }), undefined, { fresh: true })
    expect(names()).toEqual(['tower'])
    expect(isDirty()).toBe(false)
  })

  it('a second open while the first still runs asks nothing, and the first stops', async () => {
    // The first open's geometry arrives only when let go, so the second starts while it runs.
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const slow = { ...host, slicer: { loadParts: async (name: string) => (name === 'tower' ? (await gate, handle(name)) : handle(name)) } } as unknown as Host
    const first = openModelBytes(slow, 'tower.3mf', design('tower', { layer_height: '0.16' }), undefined, { fresh: true })
    await vi.waitFor(() => expect(get().plateLoading).toBe(true))
    await openModelBytes(host, 'clip.3mf', design('clip'), undefined, { fresh: true })
    expect(get().unsavedPrompt).toBeNull()
    expect(names()).toEqual(['clip'])
    release()
    await first
    // The first open's objects and settings never land on the second project, and nothing is left unsaved.
    expect(names()).toEqual(['clip'])
    expect(get().overrides).not.toHaveProperty('layer_height')
    expect(isDirty()).toBe(false)
    expect(get().plateLoading).toBe(false)
  })

  it('an open still running is not unsaved work, but an edit made during it is', async () => {
    markClean()
    const scope = beginOpen()
    scope.run(() => set((s) => ({ plate: [...s.plate, entry('own')] })))
    expect(isDirty()).toBe(false)
    set((s) => ({ plate: [...s.plate, entry('theirs')] }))
    expect(isDirty()).toBe(true)
    scope.finish()
    expect(isDirty()).toBe(true)
  })

  it('the scope counts only what is not its own', async () => {
    let scope = beginOpen()
    scope.run(() => set((s) => ({ plate: [...s.plate, entry('own')] })))
    scope.finish()
    expect(isDirty()).toBe(false)

    scope = beginOpen()
    scope.run(() => set((s) => ({ plate: [...s.plate, entry('own-2')] })))
    set((s) => ({ plate: [...s.plate, entry('theirs')] }))
    scope.finish()
    expect(isDirty()).toBe(true)

    // Changes that are not edits at all (the printer layer following the printer) never count against it.
    markClean()
    scope = beginOpen()
    withoutDirtying(() => set((s) => ({ overrides: { ...s.overrides, wall_loops: 4 } })))
    await scope.during(Promise.resolve().then(() => set((s) => ({ plate: s.plate.slice(1) }))))
    scope.finish()
    expect(isDirty()).toBe(false)
  })
})
