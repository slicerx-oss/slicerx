// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A new, empty project: one empty plate, no undo history and no file. Print settings, the printer and
// the filament stay as they are, the same as a new project in OrcaSlicer, except what an opened project brought.
import { history } from '../plate/history'
import { get, set } from '../state/store'
import { confirmDiscard, markClean } from './unsaved'

export function clearProject(): void {
  // The project's printer goes with it, and so do the settings and machine G-code the project brought: the plate
  // returns to the printer chosen before, with its own settings.
  const pp = get().projectPrinter
  if (pp) {
    const brought = new Set([...pp.gcodeKeys, ...(get().projectSettings?.keys ?? [])])
    const off = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !brought.has(k)))
    set((s) => ({ overrides: off(s.overrides) as typeof s.overrides, vouchedGcode: off(s.vouchedGcode) as typeof s.vouchedGcode, projectPrinter: null, ...(s.printerId === 'project-printer' ? { printerId: pp.previousPrinterId } : {}) }))
  }
  // On any printer, the print settings the project changed go back to what the person had before it opened, so an old
  // project's values never reach the next one.
  const prior = get().projectSettings?.prior
  if (prior && Object.keys(prior).length) {
    set((s) => {
      const overrides = { ...s.overrides }
      for (const [k, v] of Object.entries(prior)) {
        if (v === null) delete overrides[k]
        else overrides[k] = v
      }
      return { overrides }
    })
  }
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
    projectOpenAsk: null,
    namedValues: [],
    fileSlotColors: [],
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
