// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reopen on "Your previous plate is saved." brings the plate back as it was: still the project's file, so Save writes
// there without asking, and with its unsaved changes still unsaved. A plate that never had a file still saves as a new
// one.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileRef, Host, MeshHandle } from '@slicerx/contracts'
import { saveProject } from '../src/export/actions'
import { writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { KEPT_NOTE, keepProject, listRecent, memorySnapshots, openSnapshot, setSnapshotStore } from '../src/project/autosave'
import { isDirty, markClean, startDirtyTracking } from '../src/project/unsaved'
import { addFileRefs, openModelBytes } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const entry = (id: string, x = 60): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(20, 20, 20), name: id }], colors: ['#bd93f9'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const design = (name: string) =>
  writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [entry(name, 128)], settings: { sequence: 'by-layer' } }], bed: { widthMm: 256, depthMm: 256 }, settings: {} }).slice().buffer as ArrayBuffer

const BRACKET: FileRef = { id: 'bracket', name: 'bracket.sx3mf', size: 1, path: '/home/maker/bracket.sx3mf' }

const saveTo = vi.fn(async (ref: FileRef, data: ArrayBuffer | Blob) => ({ ...ref, size: data instanceof Blob ? data.size : data.byteLength }))
const save = vi.fn(async (name: string) => ({ id: 'new', name, size: 1, path: `/home/maker/${name}` }))
const host = {
  kind: 'desktop',
  capabilities: { threads: 1 },
  slicer: { loadParts: async (name: string) => handle(name) },
  files: { read: async (ref: FileRef) => design(ref.name.replace(/\.sx3mf$/, '')), save, saveTo },
} as unknown as Host

const names = () => get().plate.map((p) => p.name)

/** Opens bracket.sx3mf from its path, as Open or a launch file does. */
async function openBracket(): Promise<void> {
  await addFileRefs(host, [BRACKET], { fresh: true })
  expect(names()).toEqual(['bracket'])
  expect(get().projectFile).toEqual(BRACKET)
  expect(isDirty()).toBe(false)
}

/** Another design opened over the plate, then Reopen on the note it leaves. */
async function replaceAndReopen(back: string[]): Promise<void> {
  await openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
  expect(names()).toEqual(['tower'])
  expect(get().projectFile).toBeNull()
  // The kept note sits under the printer card, with the open's own note.
  const note = get().openNote
  expect(note?.text).toBe(KEPT_NOTE)
  expect(note?.action?.label).toBe('Reopen')
  note!.action!.run()
  await vi.waitFor(() => expect(names()).toEqual(back))
  await vi.waitFor(() => expect(get().plateLoading).toBe(false))
}

// The keep writes the project with the exporter, loaded on demand; load it before the opens below.
beforeAll(async () => void (await import('../src/export/actions')))

beforeEach(() => {
  setSnapshotStore(memorySnapshots())
  set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', selection: null, selectedIds: [], unsavedPrompt: null, projectOpenAsk: null, projectFile: null, toast: null, openNote: null, overrides: {} })
  startDirtyTracking()
  markClean()
  saveTo.mockClear()
  save.mockClear()
})

describe('Reopen after a plate was replaced', () => {
  it('a project opened from a file comes back as that file, unsaved, and Save writes there without asking', async () => {
    await openBracket()
    // An edit: the project has changes that were never saved.
    set((s) => ({ plate: [...s.plate, entry('clip', 60)] }))
    expect(isDirty()).toBe(true)
    await replaceAndReopen(['bracket', 'clip'])
    expect(get().projectFile).toEqual(BRACKET)
    expect(get().projectFile?.path).toBe('/home/maker/bracket.sx3mf')
    expect(get().projectFile?.name).toBe('bracket.sx3mf')
    // The edit is still unsaved: nothing wrote it to bracket.sx3mf yet.
    expect(isDirty()).toBe(true)
    expect(await saveProject(host)).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(saveTo).toHaveBeenCalledTimes(1)
    expect(saveTo.mock.calls[0]?.[0]).toMatchObject({ path: '/home/maker/bracket.sx3mf', name: 'bracket.sx3mf' })
    expect(isDirty()).toBe(false)
  })

  it('a project kept with no unsaved changes comes back as that file and clean', async () => {
    await openBracket()
    // An open over a clean plate keeps nothing (it is in its file already); kept by hand, it comes back as it was.
    const snap = await keepProject()
    expect(snap).not.toBeNull()
    await openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    expect(get().projectFile).toBeNull()
    await openSnapshot(host, snap!)
    expect(names()).toEqual(['bracket'])
    expect(get().projectFile).toEqual(BRACKET)
    expect(isDirty()).toBe(false)
    expect(await saveProject(host)).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(saveTo.mock.calls[0]?.[0]).toMatchObject({ path: '/home/maker/bracket.sx3mf' })
  })

  it('a plate that never had a file comes back unsaved and still asks for a name on Save', async () => {
    set({ plate: [entry('a'), entry('b', 100)] })
    expect(isDirty()).toBe(true)
    await replaceAndReopen(['a', 'b'])
    expect(get().projectFile).toBeNull()
    expect(isDirty()).toBe(true)
    expect(await saveProject(host)).toBe(true)
    expect(saveTo).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a recent project stored before Reopen kept the file opens as before: no file, clean', async () => {
    await openBracket()
    set((s) => ({ plate: [...s.plate, entry('clip', 60)] }))
    await openModelBytes(host, 'tower.sx3mf', design('tower'), undefined, { fresh: true })
    const [kept] = await listRecent()
    expect(kept?.name).toBe('bracket.sx3mf')
    const { file: _file, dirty: _dirty, ...older } = kept as typeof kept & { file?: unknown; dirty?: unknown }
    markClean()
    await openSnapshot(host, older)
    expect(names()).toEqual(['bracket', 'clip'])
    expect(get().projectFile).toBeNull()
    expect(isDirty()).toBe(false)
  })
})
