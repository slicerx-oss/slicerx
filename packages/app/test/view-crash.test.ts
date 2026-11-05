// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// After the desktop shell reloads a window whose view stopped: the autosave comes back without asking, and the notice
// says what came back and what was lost.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { AUTOSAVE_ID, memorySnapshots, resetAutosaveSession, setSnapshotStore, type Snapshot } from '../src/project/autosave'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { recoverAfterViewCrash, viewCrashNote } from '../src/project/view-crash'
import { get, set } from '../src/state/store'

const host = {} as Host
const entry = (id: string) => ({ id, name: id, handle: { id, hash: id, name: id, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as never
// 3:42:10 PM local time, whatever the zone the test runs in.
const savedAt = new Date(2026, 10, 5, 15, 42, 10).getTime()
const autosave: Snapshot = { id: AUTOSAVE_ID, name: 'bracket.sx3mf', savedAt, objects: 2, data: new Uint8Array([1]) }

beforeEach(() => {
  setSnapshotStore(memorySnapshots())
  resetAutosaveSession()
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', plateLoading: false, toast: null, projectsDialog: null })
  startDirtyTracking()
  markClean()
})

describe('after the view stopped and was reloaded', () => {
  it('restores unsaved work from the autosave without asking, still unsaved, and says as of when', async () => {
    const open = vi.fn(async () => undefined)
    const out = await recoverAfterViewCrash(host, { unsaved: true, at: savedAt + 2000 }, autosave, open)
    expect(out).toEqual({ kind: 'restored', savedAt })
    expect(open).toHaveBeenCalledWith(host, { ...autosave, dirty: true })
    expect(get().toast?.text).toBe('The view stopped and was reloaded. Your work was restored as autosaved at 3:42:10 PM. Changes after that, if any, were lost.')
    expect(get().toast?.tone).toBe('info')
    expect(get().projectsDialog).toBeNull()
  })

  it('reads the autosave itself when the start had not', async () => {
    await (await import('../src/project/autosave')).snapshotStore().put(autosave)
    const open = vi.fn(async () => undefined)
    expect((await recoverAfterViewCrash(host, { unsaved: true, at: 1 }, undefined, open)).kind).toBe('restored')
    expect(open).toHaveBeenCalledOnce()
  })

  it('says unsaved changes were lost when no autosave of them was written yet', async () => {
    const out = await recoverAfterViewCrash(host, { unsaved: true, at: 1 }, null, vi.fn())
    expect(out.kind).toBe('lost')
    expect(get().toast?.text).toBe('The view stopped and was reloaded. Your latest changes had not been autosaved yet and were lost.')
    expect(get().toast?.tone).toBe('warn')
  })

  it('says nothing was lost when nothing was unsaved, and restores nothing', async () => {
    const open = vi.fn()
    expect((await recoverAfterViewCrash(host, { unsaved: false, at: 1 }, null, open)).kind).toBe('clean')
    expect(get().toast?.text).toBe('The view stopped and was reloaded. Nothing unsaved was lost.')
    expect(open).not.toHaveBeenCalled()
  })

  it('offers an older autosave as at any start when nothing was unsaved at the stop', async () => {
    const open = vi.fn()
    expect((await recoverAfterViewCrash(host, { unsaved: false, at: 1 }, autosave, open)).kind).toBe('clean')
    expect(open).not.toHaveBeenCalled()
    expect(get().projectsDialog).toBe('recover')
  })

  it('leaves a locked autosave, or one that would replace work on the plates, to the restore dialog', async () => {
    const open = vi.fn()
    expect((await recoverAfterViewCrash(host, { unsaved: true, at: 1 }, { ...autosave, locked: true }, open)).kind).toBe('offered')
    expect(get().projectsDialog).toBe('recover')
    expect(get().toast?.text).toBe('The view stopped and was reloaded. Your unsaved work was kept. Restore it from the dialog.')
    set({ projectsDialog: null, plate: [entry('a')] })
    expect((await recoverAfterViewCrash(host, { unsaved: true, at: 1 }, autosave, open)).kind).toBe('offered')
    expect(open).not.toHaveBeenCalled()
  })

  it('falls back to the restore dialog when the restore fails', async () => {
    const out = await recoverAfterViewCrash(host, { unsaved: true, at: 1 }, autosave, vi.fn(async () => Promise.reject(new Error('bad file'))))
    expect(out.kind).toBe('offered')
    expect(get().projectsDialog).toBe('recover')
  })

  it('every notice starts by saying the view stopped and was reloaded', () => {
    for (const o of [{ kind: 'restored', savedAt } as const, { kind: 'offered' } as const, { kind: 'lost' } as const, { kind: 'clean' } as const]) {
      expect(viewCrashNote(o)).toMatch(/^The view stopped and was reloaded\. /)
    }
  })
})
