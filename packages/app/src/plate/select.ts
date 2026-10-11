// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Selecting objects on the plate. Kept apart from plate/edit.ts so the command bar and the startup
// shell can select without loading the plate operations (arrange, nest, mesh edits).
import { get, selectedIds, set, type PlateEntry } from '../state/store'
import { rangeSelect } from './selection'

export function selectedEntry(): PlateEntry | undefined {
  const { plate, selection } = get()
  return plate.find((p) => p.id === selection)
}

export type SelectMode = 'set' | 'toggle' | 'range'

/** The last object clicked without Shift: where a Shift range starts. */
let anchor: string | null = null
/** The selection the list's last click left, to tell when the view or Select all changed it since. */
let mine: string[] | null = null

/**
 * Click in the object list: `set` replaces, `toggle` (Mod) adds or removes, `range` (Shift) selects from the anchor
 * to `id` in list order. `true` and `false` are toggle and set.
 */
export function selectObject(id: string, mode: SelectMode | boolean): void {
  const how: SelectMode = mode === true ? 'toggle' : mode === false ? 'set' : mode
  const s = get()
  const pick = (selection: string | null, ids: string[]) => {
    mine = ids
    set({ selection, selectedIds: ids })
  }
  if (how === 'range') {
    // A selection made elsewhere (the view, Select all) since the last click starts the range at its primary.
    const from = anchor !== null && s.selectedIds === mine && s.plate.some((p) => p.id === anchor) ? anchor : s.selection
    pick(id, rangeSelect(s.plate.map((p) => p.id), from, id))
    return
  }
  anchor = id
  if (how === 'set') return pick(id, [id])
  const cur = selectedIds(s)
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
  pick(next.includes(s.selection ?? '') ? s.selection : (next[next.length - 1] ?? null), next)
}

/** Nothing selected. */
export function clearSelection(): void {
  set({ selection: null, selectedIds: [], settingsScope: 'plate', scopePart: null })
}

export function selectAll(): void {
  const ids = get().plate.map((p) => p.id)
  set({ selection: ids[0] ?? null, selectedIds: ids })
}
