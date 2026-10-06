// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's collisions in the app: the strikes of the current slice, what holds Print back, and the one-click fixes
// (a new print order, print by layer). Light enough for the startup code; the jump to a strike is heimdall-jump.ts.
import type { Collision, CollisionFix, Host } from '@slicerx/contracts'
import type { StrikeMark } from '@slicerx/viewport'
import { get, markStale, set, toast, type AppState } from '../state/store'
import { setPlateSettings } from './plates'
import { sequenceProblem } from './sequence-check'

const NONE: Collision[] = []

/** The collisions of the slice on screen. */
export function collisionsOf(s: Pick<AppState, 'slice'>): Collision[] {
  return s.slice.status === 'done' ? (s.slice.result.collisions ?? NONE) : NONE
}

const NO_FIXES: CollisionFix[] = []

export function fixesOf(s: Pick<AppState, 'slice'>): CollisionFix[] {
  return s.slice.status === 'done' ? (s.slice.result.collisionFixes ?? NO_FIXES) : NO_FIXES
}

const names = (s: Pick<AppState, 'plate'>, id: string) => s.plate.find((p) => p.id === id)?.name ?? 'an object'

/**
 * Why Print and Export are held back, or null. A strike with the head's own shape blocks; a close call only inside the
 * profile's radius goes to the Print sheet as a warning. A slice from before the objects moved is checked against the
 * plate as it sits now.
 */
export function printBlock(s: Pick<AppState, 'slice' | 'plate' | 'plates' | 'activePlate' | 'easy' | 'overrides'>): string | null {
  const hits = collisionsOf(s).filter((c) => c.severity === 'hit')
  if (hits.length) {
    return `heimdall found ${hits.length === 1 ? 'a collision' : `${hits.length} collisions`} on this plate. See ${hits.length === 1 ? 'it' : 'them'} in Preview, apply a fix or change the plate, and slice again.`
  }
  if (s.slice.status === 'done' && s.slice.stale) return sequenceProblem(s)
  return null
}

/** Close calls of the current slice, as warnings the person says yes to on the Print sheet. */
export function closeCalls(s: Pick<AppState, 'slice' | 'plate'>): string[] {
  return collisionsOf(s)
    .filter((c) => c.severity === 'close')
    .map((c) => `${names(s, c.objectId)} passes within the printer profile's clearance of ${names(s, c.hitId)}. The head's own shape clears it.`)
}

/** One strike per collision where it goes deepest, the selected one marked. */
export function strikeMarks(s: Pick<AppState, 'slice' | 'strikePick'>): StrikeMark[] {
  return collisionsOf(s).map((c, i) => ({ x: c.worstPoint[0], y: c.worstPoint[1], z: c.worstPoint[2], ...(c.severity === 'close' ? { close: true } : {}), ...(s.strikePick === i ? { selected: true } : {}) }))
}

/**
 * Shows collision `i`: the sliders go to its moment, the head is drawn there, and the playback bar plays the seconds
 * before it and stops on it. The timeline code it needs loads with Preview, so it comes in on the first jump.
 */
export function jumpToCollision(i: number): Promise<void> {
  return import('./heimdall-jump').then((m) => m.jumpTo(i))
}

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
  } else if (fix.kind === 'by_layer') {
    setPlateSettings(get().activePlate, { sequence: 'by-layer' })
    toast('This plate prints by layer now. Slicing again.', 'info')
  } else return
  set({ strikePick: null, strikeJump: null })
  const { slicePlate } = await import('../state/actions')
  await slicePlate(host)
}
