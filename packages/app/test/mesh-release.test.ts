// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Meshes the slicer loaded for objects were never released, so every engine kept every mesh of the session. A mesh
// is now released once nothing can bring its object back: no plate, no undo or redo step, no open history step and
// no clipboard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { clearClipboard, copySelection } from '../src/plate/clipboard'
import { createHistory, history } from '../src/plate/history'
import { startMeshRelease } from '../src/plate/mesh-release'
import { sliceHandle } from '../src/plate/painted'
import { boxMesh } from '../src/plate/mesh-ops'
import { clearProject } from '../src/project/new'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

let n = 0
const handle = (): MeshHandle => ({ id: `mesh-${++n}`, hash: 'h', name: 'm', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const entry = (id: string, h = handle()): PlateEntry => ({ id, name: id, handle: h, parts: [boxMesh(10, 10, 10)], colors: ['#ffffff'], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] })

/** A slicer that counts the meshes it holds. */
function slicer() {
  const live = new Set<string>()
  return {
    live,
    load(): MeshHandle {
      const h = handle()
      live.add(h.id)
      return h
    },
    release: (id: string) => void live.delete(id),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  clearClipboard()
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', selection: null, selectedIds: [], historyEdit: null, slice: { status: 'idle' }, plateLoading: false })
})
afterEach(() => vi.useRealTimers())

describe('releasing meshes', () => {
  it('lets go of a deleted object once undo cannot bring it back', () => {
    const sl = slicer()
    const h = createHistory(appStore)
    const stop = startMeshRelease(sl, { delayMs: 10, history: h })
    const a = entry('a', sl.load())
    set({ plate: [a] })
    vi.advanceTimersByTime(20)
    set({ plate: [] })
    vi.advanceTimersByTime(20)
    // The delete can be undone, so the mesh stays.
    expect(sl.live.has(a.handle.id)).toBe(true)
    h.undo()
    expect(get().plate[0]!.handle.id).toBe(a.handle.id)
    set({ plate: [] })
    h.clear()
    vi.advanceTimersByTime(20)
    expect(sl.live.size).toBe(0)
    stop()
    h.dispose()
  })

  it('keeps a mesh the clipboard holds, and one being loaded that is not on a plate yet', () => {
    const sl = slicer()
    const h = createHistory(appStore)
    const stop = startMeshRelease(sl, { delayMs: 10, history: h })
    const a = entry('a', sl.load())
    set({ plate: [a], selection: 'a', selectedIds: ['a'] })
    vi.advanceTimersByTime(20)
    copySelection()
    const pending = sl.load()
    set({ plate: [] })
    h.clear()
    vi.advanceTimersByTime(20)
    expect(sl.live.has(a.handle.id)).toBe(true)
    expect(sl.live.has(pending.id)).toBe(true)
    clearClipboard()
    vi.advanceTimersByTime(20)
    expect(sl.live.has(a.handle.id)).toBe(false)
    stop()
    h.dispose()
  })

  it('lets go of a painted copy once its object is painted otherwise', async () => {
    vi.useRealTimers()
    const sl = slicer()
    const host = { loadModel: async () => sl.load(), release: sl.release }
    const h = createHistory(appStore)
    const stop = startMeshRelease(sl, { delayMs: 5, history: h })
    const a = { ...entry('a', sl.load()), paint: { 0: { color: { 1: '8' } } } }
    set({ plate: [a] })
    const first = await sliceHandle(host, get().plate[0]!)
    set({ plate: [{ ...a, paint: { 0: { color: { 2: '8' } } } }] })
    const second = await sliceHandle(host, get().plate[0]!)
    await new Promise((r) => setTimeout(r, 30))
    expect(sl.live.has(first.id)).toBe(false)
    expect(sl.live.has(second.id)).toBe(true)
    expect(sl.live.has(a.handle.id)).toBe(true)
    stop()
    h.dispose()
  })

  it('waits for a running slice before it releases', () => {
    const sl = slicer()
    const h = createHistory(appStore)
    const stop = startMeshRelease(sl, { delayMs: 10, history: h })
    const a = entry('a', sl.load())
    set({ plate: [a] })
    vi.advanceTimersByTime(20)
    set({ plate: [], slice: { status: 'running', progress: null, startedAt: 0 } })
    h.clear()
    vi.advanceTimersByTime(100)
    expect(sl.live.has(a.handle.id)).toBe(true)
    set({ slice: { status: 'idle' } })
    vi.advanceTimersByTime(20)
    expect(sl.live.has(a.handle.id)).toBe(false)
    stop()
    h.dispose()
  })

  it('50 load, edit, slice and close cycles leave no mesh held', () => {
    const sl = slicer()
    // The app's own history, which a new project clears.
    const h = history()
    const stop = startMeshRelease(sl, { delayMs: 10 })
    for (let i = 0; i < 50; i++) {
      // Load two objects, one with a volume.
      const a = { ...entry(`a${i}`, sl.load()), volumes: [{ id: `v${i}`, name: 'v', role: 'negative' as const, handle: sl.load(), part: boxMesh(2, 2, 2), local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] }
      set({ plate: [a, entry(`b${i}`, sl.load())] })
      vi.advanceTimersByTime(20)
      // An edit loads the part again and replaces the object's mesh.
      set((s) => ({ plate: s.plate.map((e) => (e.id === `b${i}` ? { ...e, handle: sl.load() } : e)) }))
      vi.advanceTimersByTime(20)
      // A slice runs and ends.
      set({ slice: { status: 'running', progress: null, startedAt: 0 } })
      vi.advanceTimersByTime(20)
      set({ slice: { status: 'idle' } })
      vi.advanceTimersByTime(20)
      // Close: a new project.
      clearProject()
      vi.advanceTimersByTime(20)
    }
    expect(sl.live.size).toBe(0)
    stop()
    h.clear()
  })
})
