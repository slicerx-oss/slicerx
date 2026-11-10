// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a slice reads from the app state, so a slice can tell whether the plate changed while it ran.
import type { AppState } from './store'

/** Everything a slice reads. A change to any of these changes the print. */
export const INPUTS = ['plate', 'plates', 'activePlate', 'overrides', 'easy', 'objectSettings', 'slotSetup', 'printerSlots', 'flush', 'tower', 'layerMarks', 'calibration', 'userPresets', 'printerId', 'printerNozzles', 'printerExtruders', 'bed', 'profile', 'resume'] as const satisfies readonly (keyof AppState)[]

/** The layer marks as the engine gets them, as one string to compare: a color change's slot is a note in the project, not part of the print. */
export const printed = (marks: AppState['layerMarks']): string => JSON.stringify(Object.entries(marks).map(([plate, list]) => [plate, list.map((m) => [m.z, m.kind, m.gcode ?? '', ...(m.kind === 'tool_change' ? [m.slot ?? 0, m.skip ?? ''] : [])])]))

/** The printer's slots as a slice reads them: by filament and color, not what is left on a spool or its tag. */
export const slotsRead = (slots: AppState['printerSlots']): string => JSON.stringify(slots.map((slot) => [slot.id, slot.material ?? null, slot.color ?? null]))

/**
 * State outside INPUTS that goes into the slice's configuration: the nozzle volume and an opened project's flush
 * volumes (the flush matrix), and the values its printer G-code names that no setting models (slice-plate.ts
 * plateSliceConfig). They change only with the printer's model or an opened project, so they are kept apart from
 * INPUTS: the slice key reads them, and a change to them leaves a finished slice stale (resume-tops.ts stampBlock).
 */
export const KEY_CONFIG = ['printerNozzleVolume', 'projectFlush', 'projectScriptKeys'] as const satisfies readonly (keyof AppState)[]

/**
 * The KEY_CONFIG values as one string to compare. The nozzle volume and the project's flush matrix go only into a
 * multi-color plate's configuration (filament/slot-config.ts slotConfig), so `multi` false leaves them out.
 */
export const configRead = (s: Pick<AppState, (typeof KEY_CONFIG)[number]>, multi: boolean): string =>
  JSON.stringify(KEY_CONFIG.map((k) => (multi || k === 'projectScriptKeys' ? (s[k] ?? null) : null)))

/**
 * True when any slice input differs between the two states. A note on a layer mark alone changes nothing printed, and
 * neither does a spool reload that only changes the grams left or the tag (slotsRead).
 */
export const inputsChanged = (a: AppState, b: AppState): boolean =>
  INPUTS.some((k) => a[k] !== b[k] && !(k === 'layerMarks' && printed(a.layerMarks) === printed(b.layerMarks)) && !(k === 'printerSlots' && slotsRead(a.printerSlots) === slotsRead(b.printerSlots)))

/**
 * True when the one slice input that moved is the flush settings, rewritten with the same values: the measured flush
 * tables landing (filament/flush.ts onFlushData), so every reader works its flush volumes out again. Nothing a person
 * set has changed.
 */
export const flushRefreshOnly = (a: AppState, b: AppState): boolean => {
  if (a.flush === b.flush || inputsChanged({ ...a, flush: b.flush }, b)) return false
  const keys = Object.keys(a.flush) as (keyof AppState['flush'])[]
  return keys.length === Object.keys(b.flush).length && keys.every((k) => a.flush[k] === b.flush[k])
}
