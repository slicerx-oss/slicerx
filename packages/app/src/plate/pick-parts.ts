// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One click on a warning or a collision picks the parts it names: they become the selection (the first primary), a
// ring in the selection color marks each one on the bed while they stay selected, and the view frames them when some
// of them are off screen. The same on a phone, where the toolpaths hide a selected part's outline and the sheet the row
// sits in goes down, so the parts show.
import type { PickRing } from '@slicerx/viewport'
import { isPhoneLayout } from '../lib/phone-layout'
import { sheets } from '../shell/pane'
import { get, selectedIds, set, type AppState } from '../state/store'
import { showsDesign } from '../state/model-mode'
import { activeClearance, shapeOf } from './sequence-check'
import { cameraBus } from './tools'

/**
 * Selects the plate objects among `ids` (the first one primary), rings them unless `ring` is false (a by-object plate
 * already rings a selected object's clearance zone), and frames them when they are not all in view unless `frame` is
 * false (the caller turns the camera itself). Ids not on the plate are left out. Answers the ids selected.
 */
export function pickParts(ids: readonly (string | null | undefined)[], opts: { ring?: boolean; frame?: boolean } = {}): string[] {
  const plate = get().plate
  const picked = [...new Set(ids)].filter((id): id is string => !!id && plate.some((p) => p.id === id))
  if (picked.length === 0) return []
  set({ selection: picked[0]!, selectedIds: picked, towerSelected: false, pickRing: opts.ring === false ? null : picked })
  if (isPhoneLayout()) sheets.setState({ open: null })
  // The view has the new selection by now: the store's listeners run as it changes.
  if (opts.frame !== false) cameraBus()?.showSelection?.({ animate: true })
  return picked
}

/** Whether the selection is exactly `ids`, in any order. */
export function isPicked(s: Pick<AppState, 'selection' | 'selectedIds'>, ids: readonly string[]): boolean {
  const now = selectedIds(s)
  return ids.length > 0 && now.length === ids.length && ids.every((id) => now.includes(id))
}

type RingInputs = Pick<AppState, 'pickRing' | 'selection' | 'selectedIds' | 'plate' | 'plates' | 'activePlate' | 'easy' | 'overrides' | 'profile' | 'workspace' | 'modelMode' | 'slice'> & Partial<Pick<AppState, 'objectSettings'>>

/**
 * The rings the bed shows: the picked parts while they are the selection, in Slice. None while a by-object plate's
 * clearance zones are up, since a selected zone has a ring of its own.
 */
export function pickRingsOf(s: RingInputs): PickRing[] | null {
  const ids = s.pickRing
  if (!ids || !isPicked(s, ids) || s.workspace !== 'prepare' || showsDesign(s)) return null
  const current = s.slice.status === 'done' && !s.slice.stale
  if (!current && activeClearance(s)) return null
  const rings = ids.flatMap((id) => {
    const e = s.plate.find((p) => p.id === id)
    return e ? [{ id, transform: e.transform, hull: shapeOf(e).hull }] : []
  })
  return rings.length ? rings : null
}
