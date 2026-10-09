// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_ID, MAX_RECENT, findRecovery, listRecent, memorySnapshots, projectSaved, recordRecent, setSnapshotStore, startAutosave, autosaveNow, snapshotStore } from '../src/project/autosave'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { get, set } from '../src/state/store'

const entry = (id: string) => ({ id, name: id, handle: { id, hash: id, name: id, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as never

beforeEach(() => {
  setSnapshotStore(memorySnapshots())
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', plateLoading: false })
  startDirtyTracking()
  markClean()
})
afterEach(() => vi.useRealTimers())

describe('autosave and recent projects', () => {
  it('keeps the newest few recent projects and one entry per name', async () => {
    for (let i = 0; i < MAX_RECENT + 3; i++) await recordRecent(`p${i}.sx3mf`, new Uint8Array([i]), 1)
    await recordRecent('P3.sx3mf', new Uint8Array([9]), 2)
    const list = await listRecent()
    expect(list).toHaveLength(MAX_RECENT)
    expect(list.filter((r) => r.name.toLowerCase() === 'p3.sx3mf')).toHaveLength(1)
  })

  it('offers an autosave back until the project is saved', async () => {
    await snapshotStore().put({ id: AUTOSAVE_ID, name: 'a.sx3mf', savedAt: 1, objects: 2, data: new Uint8Array([1]) })
    expect((await findRecovery())?.name).toBe('a.sx3mf')
    await projectSaved('a.sx3mf', new Uint8Array([1]))
    expect(await findRecovery()).toBeNull()
    expect((await listRecent()).map((r) => r.name)).toEqual(['a.sx3mf'])
  })

  it('clears the autosave when the plates are empty', async () => {
    await snapshotStore().put({ id: AUTOSAVE_ID, name: 'a.sx3mf', savedAt: 1, objects: 2, data: new Uint8Array([1]) })
    expect(await autosaveNow()).toBe(false)
    expect(await findRecovery()).toBeNull()
  })

  it('writes a few seconds after the last change, and only once for a burst', async () => {
    vi.useFakeTimers()
    const writes: number[] = []
    const real = snapshotStore()
    setSnapshotStore({ ...real, put: async (s) => { writes.push(s.objects); await real.put(s) } })
    const stop = startAutosave(4000)
    set({ plate: [entry('a')] })
    await vi.advanceTimersByTimeAsync(2000)
    set({ plate: [entry('a'), entry('b')] })
    await vi.advanceTimersByTimeAsync(3900)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(300)
    // The write itself (module import, compression) runs on real time.
    vi.useRealTimers()
    await vi.waitFor(() => expect(writes).toEqual([2]), { timeout: 10000 })
    stop()
    expect(get().plate).toHaveLength(2)
  })

  it('writes nothing for a project with no change since it was opened or saved', async () => {
    const writes: number[] = []
    const real = snapshotStore()
    setSnapshotStore({ ...real, put: async (snap) => { writes.push(snap.objects); await real.put(snap) } })
    set({ plate: [entry('a')] })
    // As an open leaves it: its changes are the file's.
    markClean()
    expect(await autosaveNow()).toBe(false)
    expect(writes).toEqual([])
    // Then an edit: now there is work to keep.
    set({ plate: [entry('a'), entry('b')] })
    expect(await autosaveNow()).toBe(true)
    expect(writes).toEqual([2])
  })
})
