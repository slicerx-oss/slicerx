// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a job over unsaved work never asks to save or discard it: the work is kept as a recent project first, the new
// job opens, and a note says the earlier work was kept, with Reopen. Only when keeping it fails does the open ask, so
// work is never lost without a word.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { answerOpenProject } from '../src/project/open-ask'
import { AUTOSAVE_ID, KEPT_NOTE, listRecent, memorySnapshots, openSnapshot, setSnapshotStore, snapshotStore } from '../src/project/autosave'
import { answerUnsaved, isDirty, markClean, startDirtyTracking } from '../src/project/unsaved'
import { addFileRefs, openModelBytes } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const entry = (id: string, x = 60): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(20, 20, 20), name: id }], colors: ['#bd93f9'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host
const design = (name: string, settings: Record<string, unknown> = {}) =>
  writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [entry(name, 128)], settings: { sequence: 'by-layer' } }], bed: { widthMm: 256, depthMm: 256 }, settings }).slice().buffer as ArrayBuffer

const names = () => get().plate.map((p) => p.name)

// The keep writes the project with the exporter, loaded on demand; load it before the opens below.
beforeAll(async () => void (await import('../src/export/actions')))

beforeEach(() => {
  setSnapshotStore(memorySnapshots())
  set({ plate: [entry('a'), entry('b', 100)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', selection: null, selectedIds: [], unsavedPrompt: null, projectOpenAsk: null, projectFile: null, toast: null, openNote: null, overrides: {} })
  startDirtyTracking()
  markClean()
  // An edit: the plate has work that was never saved.
  set((s) => ({ plate: [...s.plate, entry('c', 140)] }))
})

describe('opening a job over unsaved work', () => {
  it('a design opened as a new project asks nothing, keeps the work as a recent project, and Reopen brings it back', async () => {
    expect(isDirty()).toBe(true)
    await openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    expect(get().unsavedPrompt).toBeNull()
    expect(names()).toEqual(['tower'])
    expect(isDirty()).toBe(false)
    const recent = await listRecent()
    expect(recent.map((r) => [r.name, r.objects])).toEqual([['a.sx3mf', 3]])
    // It sits under the printer card with the open's own note, not over the view.
    const note = get().openNote
    expect(note?.text).toBe(KEPT_NOTE)
    expect(note?.action?.label).toBe('Reopen')
    note!.action!.run()
    await vi.waitFor(() => expect(names()).toEqual(['a', 'b', 'c']))
    expect(get().unsavedPrompt).toBeNull()
  })

  it('a file opened from the dialog (Open, a launch file, a recent file) asks nothing either', async () => {
    const files = { read: async () => design('clip') }
    await addFileRefs({ ...host, files } as unknown as Host, [{ id: 'clip', name: 'clip.sx3mf', size: 1 }], { fresh: true })
    expect(get().unsavedPrompt).toBeNull()
    expect(names()).toEqual(['clip'])
    expect((await listRecent()).map((r) => r.name)).toContain('a.sx3mf')
    expect(get().openNote?.text).toBe(KEPT_NOTE)
  })

  it('a recent project opened over unsaved work keeps it too', async () => {
    const snap = { id: 'recent:tower.sx3mf', name: 'tower.sx3mf', savedAt: 1, objects: 1, data: new Uint8Array(design('tower')) }
    await openSnapshot(host, snap)
    expect(get().unsavedPrompt).toBeNull()
    expect(names()).toEqual(['tower'])
    expect((await listRecent()).map((r) => r.name)).toContain('a.sx3mf')
    expect(get().openNote?.action?.label).toBe('Reopen')
  })

  it('another slicer project dropped on the plate as a whole project asks nothing about saving', async () => {
    const dropped = openModelBytes(host, 'tower.3mf', design('tower', { layer_height: '0.16', wall_loops: '3' }))
    // What to take from it is still the person's choice; only the save question is gone.
    await vi.waitFor(() => expect(get().projectOpenAsk).not.toBeNull())
    answerOpenProject('project')
    await dropped
    expect(get().unsavedPrompt).toBeNull()
    expect(names()).toEqual(['tower'])
    expect((await listRecent()).map((r) => [r.name, r.objects])).toEqual([['a.sx3mf', 3]])
    expect(get().openNote?.text).toContain(KEPT_NOTE.replace(/\.$/, ''))
  })

  it('keeps an opened file under its own name, and the autosave of the same work is not offered back as well', async () => {
    set({ projectFile: { id: 'f', name: 'bracket.sx3mf', size: 1, path: '/tmp/bracket.sx3mf' } })
    await snapshotStore().put({ id: AUTOSAVE_ID, name: 'a.sx3mf', savedAt: 1, objects: 3, data: new Uint8Array([1]) })
    await openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    expect((await listRecent()).map((r) => r.name)).toEqual(['bracket.sx3mf'])
    expect((await snapshotStore().list()).some((r) => r.id === AUTOSAVE_ID)).toBe(false)
  })

  it('a clean plate opens with no note at all', async () => {
    markClean()
    await openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    expect(await listRecent()).toEqual([])
    expect(get().openNote?.text).not.toBe(KEPT_NOTE)
  })

  it('asks after all when the work cannot be kept: Cancel keeps the plate, Discard opens', async () => {
    const real = snapshotStore()
    setSnapshotStore({ ...real, put: async () => Promise.reject(new Error('QuotaExceededError')) })
    const canceled = openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    await vi.waitFor(() => expect(get().unsavedPrompt).toEqual({ what: 'open another design' }))
    answerUnsaved(false)
    await canceled
    expect(names()).toEqual(['a', 'b', 'c'])
    expect(isDirty()).toBe(true)
    const discarded = openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    await vi.waitFor(() => expect(get().unsavedPrompt).not.toBeNull())
    answerUnsaved(true)
    await discarded
    expect(names()).toEqual(['tower'])
    // Nothing was kept, so nothing says it was, under the printer card or over the view.
    expect(get().openNote?.text ?? '').not.toContain(KEPT_NOTE)
    expect(get().toast?.text ?? '').not.toContain(KEPT_NOTE)
  })
})
