// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's one-click fixes: a new print order, print by layer, or the plate arranged again, then a new slice.
import type { CollisionFix, Host } from '@slicerx/contracts'
import { slicePlate } from '../state/actions'
import { get, markStale, set, toast } from '../state/store'
import { arrangePlate } from './edit'
import { setPlateSettings } from './plates'

/** Reorders the plate's objects to `order` (ids); objects it leaves out keep their places after it. */
function reorder(order: readonly string[]): boolean {
  const plate = get().plate
  const rank = new Map(order.map((id, i) => [id, i]))
  const next = [...plate].sort((x, y) => (rank.get(x.id) ?? order.length + plate.indexOf(x)) - (rank.get(y.id) ?? order.length + plate.indexOf(y)))
  if (next.every((e, i) => e === plate[i])) return false
  set({ plate: next })
  markStale()
  return true
}

/** Applies a one-click fix and slices again. */
export async function applyCollisionFix(host: Host, fix: CollisionFix): Promise<void> {
  if (!fix.oneClick) return
  if (fix.kind === 'reorder' && fix.order) {
    if (!reorder(fix.order)) return
    toast('The objects print in the new order. Slicing again.', 'info')
  } else if (fix.kind === 'arrange') {
    await arrangePlate('all')
    toast('The plate is arranged again. Slicing again.', 'info')
  } else if (fix.kind === 'by_layer') {
    setPlateSettings(get().activePlate, { sequence: 'by-layer' })
    toast('This plate prints by layer now. Slicing again.', 'info')
  } else return
  set({ strikePick: null, strikeJump: null })
  await slicePlate(host)
}
