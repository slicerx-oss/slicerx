// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The offer to restore unsaved work waits while the command bar is open, and goes up once when the bar closes, however
// it closes. A modal dialog over the open bar would keep the bar inert and take its focus. When it goes up, it follows
// the start's rule: only while nothing on the plate would be lost.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offerRecovery, resetAutosaveSession } from '../src/project/autosave'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { closeCommandBar } from '../src/shell/command-draft'
import { appStore, get, set } from '../src/state/store'

const entry = (id: string) => ({ id, name: id, handle: { id, hash: id, name: id, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as never

let raised = 0
let off = () => {}
let stop = () => {}

beforeEach(() => {
  resetAutosaveSession()
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', plateLoading: false, commandOpen: false, projectsDialog: null, workspace: 'prepare' })
  startDirtyTracking()
  markClean()
  raised = 0
  off = appStore.subscribe((s, prev) => {
    if (s.projectsDialog === 'recover' && prev.projectsDialog !== 'recover') raised++
  })
})

afterEach(() => {
  stop()
  off()
  set({ commandOpen: false, projectsDialog: null })
})

describe('the offer to restore unsaved work', () => {
  it('goes up at once while the command bar is shut', () => {
    stop = offerRecovery()
    expect(get().projectsDialog).toBe('recover')
    expect(raised).toBe(1)
  })

  it('waits while the bar is open, and goes up once when Escape closes it', () => {
    set({ commandOpen: true })
    stop = offerRecovery()
    expect(get().projectsDialog).toBeNull()
    closeCommandBar()
    expect(get().projectsDialog).toBe('recover')
    expect(raised).toBe(1)
  })

  it('goes up when the bar is shut by something else, such as setup starting', () => {
    set({ commandOpen: true })
    stop = offerRecovery()
    set({ setup: { step: 'theme' }, commandOpen: false } as never)
    expect(raised).toBe(1)
    set({ setup: null } as never)
  })

  it('keeps waiting through a tab change while the bar stays open', () => {
    set({ commandOpen: true })
    stop = offerRecovery()
    set({ workspace: 'library' })
    set({ workspace: 'prepare' })
    expect(raised).toBe(0)
    closeCommandBar()
    expect(raised).toBe(1)
  })

  it('goes up only once, however often the bar opens and closes after', () => {
    set({ commandOpen: true })
    stop = offerRecovery()
    closeCommandBar()
    // the person answers it, then uses the bar again
    set({ projectsDialog: null })
    for (let i = 0; i < 3; i++) {
      set({ commandOpen: true })
      closeCommandBar()
    }
    expect(raised).toBe(1)
    expect(get().projectsDialog).toBeNull()
  })

  it('never goes up once the app has stopped before the bar closed', () => {
    set({ commandOpen: true })
    stop = offerRecovery()
    stop()
    closeCommandBar()
    expect(raised).toBe(0)
  })

  it('still goes up after a command that started a new project before the bar closed', () => {
    set({ commandOpen: true })
    stop = offerRecovery()
    // New project: the plate is emptied, so there is nothing to lose
    set({ plate: [], plates: [{ id: 'plate-2', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-2' })
    closeCommandBar()
    expect(raised).toBe(1)
  })

  it('does not go up after a command opened other work before the bar closed, as at the start', () => {
    set({ commandOpen: true })
    stop = offerRecovery()
    const work = entry('bracket')
    set({ plate: [work], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [work], settings: { sequence: 'by-layer' } }] })
    closeCommandBar()
    expect(raised).toBe(0)
    expect(get().projectsDialog).toBeNull()
  })
})
