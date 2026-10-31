// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Quitting with Don't save drops the work on purpose, so the next start does not offer it back. A crash, a forced quit
// or a quit nobody answered (a shutdown) still leaves it to restore.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AUTOSAVE_ID, SNAPSHOT_VERSION, autosaveNow, discardRecovery, findRecovery, listRecent, memorySnapshots, recordRecent, resetAutosaveSession, setSnapshotStore, snapshotStore, type SnapshotStore } from '../src/project/autosave'
import { answerUnsaved, confirmDiscard, markClean, startDirtyTracking } from '../src/project/unsaved'
import { set } from '../src/state/store'

const entry = (id: string) => ({ id, name: id, handle: { id, hash: id, name: id, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as never

// The write imports the project exporter on demand; load it before the tests time anything.
beforeAll(async () => void (await import('../src/export/actions')))

/** The device's storage, which outlives the app: each test's "next start" reads the same one. */
let disk: SnapshotStore

beforeEach(() => {
  disk = memorySnapshots()
  setSnapshotStore(disk)
  resetAutosaveSession()
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', plateLoading: false, unsavedPrompt: null })
  startDirtyTracking()
  markClean()
})

/** An unsaved change that the autosave has written, as a few seconds after an edit. */
async function unsavedWork(): Promise<void> {
  set({ plate: [entry('a')] })
  expect(await autosaveNow()).toBe(true)
  expect((await findRecovery())?.objects).toBe(1)
}

/** The next start: a new page session over the same storage, asking what to offer back. */
async function relaunch() {
  resetAutosaveSession()
  setSnapshotStore(disk)
  return findRecovery()
}

describe("Don't save clears the work kept for a restore", () => {
  it("quitting with Don't save offers nothing back at the next start", async () => {
    await unsavedWork()
    const quit = confirmDiscard('quit')
    await answerUnsaved(true)
    // The shell exits as soon as this resolves, so the copy must be gone by then.
    await expect(quit).resolves.toBe(true)
    expect((await disk.list()).some((s) => s.id === AUTOSAVE_ID)).toBe(false)
    expect(await relaunch()).toBeNull()
  })

  it('a crash, forced quit or unanswered quit still offers the work back', async () => {
    await unsavedWork()
    // Nothing answered: the process just ends.
    const r = await relaunch()
    expect(r?.name).toBe('a.sx3mf')
    expect(r?.objects).toBe(1)
  })

  it('Cancel keeps the work and its copy', async () => {
    await unsavedWork()
    const quit = confirmDiscard('quit')
    await answerUnsaved(false)
    await expect(quit).resolves.toBe(false)
    expect(await relaunch()).not.toBeNull()
  })

  it("an autosave still being written when Don't save is picked does not land after the clear", async () => {
    set({ plate: [entry('a')] })
    const writing = autosaveNow()
    const quit = confirmDiscard('quit')
    await answerUnsaved(true)
    await quit
    await writing
    expect(await relaunch()).toBeNull()
  })

  it("leaves another session's kept work and the recent projects alone", async () => {
    // Work an earlier session kept that this one never wrote over (its restore offer was closed, not answered).
    await disk.put({ id: AUTOSAVE_ID, name: 'bracket.sx3mf', savedAt: 1, objects: 2, data: new Uint8Array([1]), v: SNAPSHOT_VERSION })
    await recordRecent('older.sx3mf', new Uint8Array([2]), 1)
    // An edit quit before the autosave wrote it.
    set({ plate: [entry('a')] })
    const quit = confirmDiscard('quit')
    await answerUnsaved(true)
    await quit
    expect((await relaunch())?.name).toBe('bracket.sx3mf')
    expect((await listRecent()).map((r) => r.name)).toEqual(['older.sx3mf'])
  })

  it('Discard in the restore offer clears it', async () => {
    await unsavedWork()
    const offered = await relaunch()
    expect(offered).not.toBeNull()
    await discardRecovery()
    expect(await relaunch()).toBeNull()
    expect(await snapshotStore().list()).toEqual([])
  })
})
