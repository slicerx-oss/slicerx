// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a slice reads from the app state, so a slice can tell whether the plate changed while it ran.
import type { AppState } from './store'

/** Everything a slice reads. A change to any of these changes the print. */
export const INPUTS = ['plate', 'plates', 'activePlate', 'overrides', 'easy', 'objectSettings', 'slotSetup', 'printerSlots', 'flush', 'tower', 'layerMarks', 'calibration', 'userPresets', 'printerId', 'printerNozzles', 'printerExtruders', 'bed', 'profile', 'resume'] as const satisfies readonly (keyof AppState)[]

/** True when any slice input differs between the two states. */
export const inputsChanged = (a: AppState, b: AppState): boolean => INPUTS.some((k) => a[k] !== b[k])
