// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's collisions in the app: the strikes of the current slice, what holds Print back, and the fixes on offer.
// Light enough for the startup code; the jump to a strike is heimdall-jump.ts and the one-click
// fixes heimdall-fix.ts, both loaded with the strike list and marks once a slice has a collision.
import type { Collision, CollisionFix } from '@slicerx/contracts'
import type { StrikeMark } from '@slicerx/viewport'
import type { AppState } from '../state/store'
import { sequenceProblem } from './sequence-check'

const NONE: Collision[] = []

/** The collisions of the slice on screen. */
export function collisionsOf(s: Pick<AppState, 'slice'>): Collision[] {
  return s.slice.status === 'done' ? (s.slice.result.collisions ?? NONE) : NONE
}

const NO_FIXES: CollisionFix[] = []

/**
 * The plate objects a collision names: the one printing, then the one it meets when that is a part on the plate (a
 * keep-out zone or the prime tower is not one). Both for a strike between two parts, one for the gantry over a part
 * of its own or a path into a zone.
 */
export function collisionParts(s: Pick<AppState, 'plate'>, c: Pick<Collision, 'objectId' | 'hitId'>): string[] {
  return [...new Set([c.objectId, c.hitId])].filter((id) => s.plate.some((p) => p.id === id))
}

export function fixesOf(s: Pick<AppState, 'slice'>): CollisionFix[] {
  return s.slice.status === 'done' ? (s.slice.result.collisionFixes ?? NO_FIXES) : NO_FIXES
}

/**
 * Why Print and Export are held back, or null. A strike with the head's own shape blocks; a close call only inside the
 * profile's radius goes to the Print sheet as a warning. A slice from before the objects moved is checked against the
 * plate as it sits now.
 */
export function printBlock(s: Pick<AppState, 'slice' | 'plate' | 'plates' | 'activePlate' | 'easy' | 'overrides' | 'profile'>): string | null {
  const hits = collisionsOf(s).filter((c) => c.severity === 'hit')
  if (hits.length) {
    return `heimdall found ${hits.length === 1 ? 'a collision' : `${hits.length} collisions`} on this plate. See ${hits.length === 1 ? 'it' : 'them'} in Slice, apply a fix or change the plate, and slice again.`
  }
  if (s.slice.status === 'done' && s.slice.stale) return sequenceProblem(s)
  return null
}

/**
 * One strike per collision where it goes deepest, the selected one marked. A strike shows once Preview reaches the
 * layer it starts on, so the bed is not marked before the part is there; before then the picked one and the one under
 * the pointer in the list show as a faint ghost, to say where to look.
 */
export function strikeMarks(s: Pick<AppState, 'slice' | 'strikePick' | 'strikeHover' | 'layerHi'> & Partial<Pick<AppState, 'plate' | 'pickRing' | 'selection' | 'selectedIds'>>): StrikeMark[] {
  const out: StrikeMark[] = []
  // A strike whose parts were picked and are still the selection steps back: the rings round them lead.
  const ringed = s.pickRing && s.plate && s.selection && s.selectedIds?.includes(s.selection) && s.selectedIds.length === s.pickRing.length && s.pickRing.every((id) => s.selectedIds!.includes(id)) ? new Set(s.pickRing) : null
  const plate = s.plate
  collisionsOf(s).forEach((c, i) => {
    const early = s.layerHi - 1 < c.layer
    if (early && s.strikePick !== i && s.strikeHover !== i) return
    const parts = ringed && plate ? collisionParts({ plate }, c) : []
    const steps = parts.length > 0 && parts.every((id) => ringed!.has(id))
    out.push({ x: c.worstPoint[0], y: c.worstPoint[1], z: c.worstPoint[2], ...(c.severity === 'close' ? { close: true } : {}), ...(s.strikePick === i ? { selected: true } : {}), ...(early ? { ghost: true } : {}), ...(steps ? { yield: true } : {}) })
  })
  return out
}
