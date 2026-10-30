// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a plate edge drag does on release past the line: the parts go to another plate, or to a new plate after the
// others, as one undo step, and then the view follows them there with them selected.
import { get, set } from '../../state/store'
import { inStep } from '../history'
import { moveObjectsToPlate } from '../move-to-plate'
import { activeMeta, addPlate, switchPlate } from '../plates'

/** Where the parts go: a plate by id, or a new plate. */
export type Destination = { plateId: string } | 'new'

/**
 * Moves the objects to the destination as one undo step: a new plate and the move into it undo together. Returns the
 * plate they went to, or null when nothing moved (the plate is gone, or none of the objects are on the shown plate).
 * The view stays on the shown plate; `follow` shows the plate they went to.
 */
export function sendToPlate(ids: readonly string[], to: Destination): string | null {
  const s = get()
  const moving = ids.filter((id) => s.plate.some((p) => p.id === id))
  if (!moving.length) return null
  if (to !== 'new' && (to.plateId === s.activePlate || !s.plates.some((p) => p.id === to.plateId))) return null
  let target: string | null = null
  inStep({}, () => {
    const id = to === 'new' ? addPlate(activeMeta()?.settings ?? {}, false) : to.plateId
    if (moveObjectsToPlate(id, moving) > 0) target = id
  })
  return target
}

/** Shows the plate the parts went to with them selected. Switching plates is not an edit, so undo skips it. */
export function follow(plateId: string, ids: readonly string[]): void {
  if (!get().plates.some((p) => p.id === plateId)) return
  switchPlate(plateId)
  const s = get()
  if (s.activePlate !== plateId) return
  const here = ids.filter((id) => s.plate.some((p) => p.id === id))
  if (here.length) set({ selection: here[0]!, selectedIds: here })
}
