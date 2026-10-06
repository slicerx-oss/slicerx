// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's collisions in the app: the strikes of the current slice, what holds Print back, the jump that plays the
// head to the moment of a strike, and the one-click fixes (a new print order, print by layer).
import type { Collision, CollisionFix, Host } from '@slicerx/contracts'
import type { StrikeMark } from '@slicerx/viewport'
import { buildTimeline, changeBefore, fitOf, timeAt } from '../lib/preview-timeline'
import { toolChangerFor } from '../lib/toolchanger'
import { cameraBus } from './tools'
import { get, markStale, set, toast, type AppState } from '../state/store'
import { setPlateSettings } from './plates'
import { sequenceProblem } from './sequence-check'
import { collisionTitle, fixTitle, namesOf, stationOf, type Names } from './heimdall-words'

const NONE: Collision[] = []

/** Object names and the tool changer's station, for the words of the collisions (heimdall-words.ts). */
export function wordsOf(s: AppState): { name: Names; station: string } {
  return { name: namesOf(s.plate), station: stationOf(toolChangerFor(s)?.kind) }
}

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
    const first = hits[0]!
    return `heimdall found ${hits.length === 1 ? 'a collision' : `${hits.length} collisions`}: ${collisionTitle(first, namesOf(s.plate))}${hits.length > 1 ? `, and ${hits.length - 1} more` : ''}. Apply a fix in Preview, or change the plate, and slice again.`
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

/** The playback time of a collision's first moment on Preview's own timeline, or null without a preview. */
export function collisionTime(s: AppState, c: Collision): number | null {
  const p = s.preview
  if (!p || c.layer >= p.layerCount) return null
  const tl = buildTimeline(p, toolChangerFor(s), fitOf(s.slice.status === 'done' ? s.slice.result.stats : null))
  const a = p.layerStart[c.layer] ?? 0
  const b = p.layerStart[c.layer + 1] ?? a
  const seg = a + Math.min(c.segment, Math.max(0, b - a - 1))
  if (c.change) {
    const ch = changeBefore(tl, seg)
    if (ch) return ch.start + Math.min(1, Math.max(0, c.change[2])) * ch.duration
  }
  // Halfway along the move, so the moment lands inside its layer even on the layer's first move.
  return timeAt(tl, p, c.layer + 1, b > a ? (seg - a + 0.5) / (b - a) : 1)
}

let jumps = 0

/**
 * Shows collision `i`: the sliders go to its moment, the head is drawn there, and the playback bar plays the seconds
 * before it and stops on it.
 */
export function jumpToCollision(i: number): void {
  const s = get()
  const c = collisionsOf(s)[i]
  if (!c) return
  const p = s.preview
  const a = p?.layerStart[c.layer] ?? 0
  const b = p?.layerStart[c.layer + 1] ?? a
  const t = collisionTime(s, c)
  set({
    strikePick: i,
    showToolhead: true,
    layerLo: 1,
    layerHi: c.layer + 1,
    moveCut: b > a ? Math.min(1, (Math.min(c.segment, b - a - 1) + 0.5) / (b - a)) : 1,
    toolChange: null,
    ...(t !== null ? { strikeJump: { timeS: t, seq: ++jumps } } : {}),
  })
  cameraBus()?.focusBedPoint?.(c.worstPoint[0], c.worstPoint[1], c.worstPoint[2], { animate: true })
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
    toast(`${fixTitle(fix, namesOf(get().plate), get().plate.map((p) => p.id))}. Slicing again.`, 'info')
  } else if (fix.kind === 'by_layer') {
    setPlateSettings(get().activePlate, { sequence: 'by-layer' })
    toast('This plate prints by layer now. Slicing again.', 'info')
  } else return
  set({ strikePick: null, strikeJump: null })
  const { slicePlate } = await import('../state/actions')
  await slicePlate(host)
}
