// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A new, empty project: one empty plate, no undo history and no file. Print settings, the printer and
// the filament stay as they are, the same as a new project in OrcaSlicer.
import { history } from '../plate/history'
import { set } from '../state/store'
import { confirmDiscard, markClean } from './unsaved'

export function clearProject(): void {
  set({
    plate: [],
    plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }],
    activePlate: 'plate-1',
    selection: null,
    selectedIds: [],
    layerMarks: {},
    objectSettings: {},
    historyEdit: null,
    slice: { status: 'idle' },
    preview: null,
    projectFile: null,
    // A project's G-code waiting for a choice goes with the project; G-code already chosen is a print setting and stays.
    projectGcode: null,
    projectSettings: null,
    namedValues: [],
  })
  history().clear()
  markClean()
}

/** Starts a new project after asking about unsaved changes. Resolves false when the person canceled. */
export async function newProject(): Promise<boolean> {
  if (!(await confirmDiscard('start a new project'))) return false
  clearProject()
  return true
}
