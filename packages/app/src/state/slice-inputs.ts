// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a slice reads from the app state, so a slice can tell whether the plate changed while it ran.
import type { AppState } from './store'

/** Everything a slice reads. A change to any of these changes the print. */
export const INPUTS = ['plate', 'plates', 'activePlate', 'overrides', 'easy', 'objectSettings', 'slotSetup', 'printerSlots', 'flush', 'tower', 'layerMarks', 'calibration', 'userPresets', 'printerId', 'printerNozzles', 'printerExtruders', 'bed', 'profile', 'resume'] as const satisfies readonly (keyof AppState)[]

/** The layer marks as the engine gets them, as one string to compare: a color change's slot is a note in the project, not part of the print. */
export const printed = (marks: AppState['layerMarks']): string => JSON.stringify(Object.entries(marks).map(([plate, list]) => [plate, list.map((m) => [m.z, m.kind, m.gcode ?? ''])]))

/** True when any slice input differs between the two states. A note on a layer mark alone changes nothing printed. */
export const inputsChanged = (a: AppState, b: AppState): boolean => INPUTS.some((k) => a[k] !== b[k] && !(k === 'layerMarks' && printed(a.layerMarks) === printed(b.layerMarks)))
