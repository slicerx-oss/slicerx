// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's plates as the plate picker, the keys and clients see them: each plate's number, name, object count and
// slice state, stepping to the previous or next plate, and showing one by number or id. Showing a plate changes only
// what the window shows, never the project (switchPlate in plates.ts).
import { keptSlice } from '../workspaces/preview/plate-slices'
import { get, type AppState } from '../state/store'
import { switchPlate } from './plates'

/** A plate's slice: none to make (no objects), not sliced yet, slicing now, sliced, or sliced before the settings changed. */
export type PlateSliceState = 'empty' | 'not-sliced' | 'slicing' | 'sliced' | 'stale'

export interface PlateRow {
  id: string
  /** 1-based, as the picker shows it. */
  number: number
  name: string
  objects: number
  state: PlateSliceState
  shown: boolean
}

export const SLICE_STATE_LABEL: Record<PlateSliceState, string> = {
  empty: 'Empty',
  'not-sliced': 'Not sliced',
  slicing: 'Slicing',
  sliced: 'Sliced',
  stale: 'Settings changed',
}

type RowState = Pick<AppState, 'plates' | 'plate' | 'activePlate' | 'slice'>

/** One plate's slice state. The plate in view reads the slice on screen; the others read the slice kept for them. */
export function sliceStateOf(id: string, objects: number, s: RowState, kept: (id: string) => { stale: boolean } | null = (k) => keptSlice(k)): PlateSliceState {
  if (objects === 0) return 'empty'
  if (id === s.activePlate) {
    if (s.slice.status === 'running') return 'slicing'
    if (s.slice.status === 'done') return s.slice.stale ? 'stale' : 'sliced'
    return 'not-sliced'
  }
  const k = kept(id)
  return k ? (k.stale ? 'stale' : 'sliced') : 'not-sliced'
}

/** Every plate in project order, the one in view marked. */
export function plateRows(s: RowState = get(), kept?: (id: string) => { stale: boolean } | null): PlateRow[] {
  return s.plates.map((p, i) => {
    const shown = p.id === s.activePlate
    const objects = shown ? s.plate.length : p.objects.length
    return { id: p.id, number: i + 1, name: p.name, objects, state: sliceStateOf(p.id, objects, s, kept), shown }
  })
}

/** The plate's own name, or nothing when it is just "Plate N" (the picker already says Plate N). */
export function plateSubtitle(name: string, number: number): string {
  return name.trim() === `Plate ${number}` ? '' : name.trim()
}

/** The plate `dir` steps from the active one: null at either end (stepping stops there rather than wrapping). */
export function stepTarget(plates: readonly { id: string }[], active: string, dir: -1 | 1): string | null {
  const i = plates.findIndex((p) => p.id === active)
  if (i < 0) return null
  return plates[i + dir]?.id ?? null
}

/** Shows the previous or next plate. Returns the plate now shown, or null when there is none that way. */
export function stepPlate(dir: -1 | 1): string | null {
  const s = get()
  const to = stepTarget(s.plates, s.activePlate, dir)
  if (to) switchPlate(to)
  return to
}

/** A plate by its 1-based number or its id; undefined when there is none. */
export function findPlate(plates: readonly { id: string }[], ref: number | string): string | undefined {
  if (typeof ref === 'number') return Number.isInteger(ref) ? plates[ref - 1]?.id : undefined
  return plates.find((p) => p.id === ref)?.id
}

/**
 * The plates a search and the Not sliced filter keep. Each word of the query must match the plate's name or its
 * number; Not sliced keeps the plates that have objects and no current slice.
 */
export function filterPlates(rows: readonly PlateRow[], query: string, notSliced: boolean): PlateRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((r) => {
    if (notSliced && !(r.state === 'not-sliced' || r.state === 'stale')) return false
    const name = r.name.toLowerCase()
    // A number finds that plate, and names with that whole number in them ("set of 4"); "plate 12" reads the same.
    return words.every((w) => (/^\d+$/.test(w) ? r.number === Number(w) || new RegExp(`(^|\\D)${w}(\\D|$)`).test(name) : name.includes(w) || 'plate'.startsWith(w)))
  })
}
