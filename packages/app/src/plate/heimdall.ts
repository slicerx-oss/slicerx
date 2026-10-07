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

export function fixesOf(s: Pick<AppState, 'slice'>): CollisionFix[] {
  return s.slice.status === 'done' ? (s.slice.result.collisionFixes ?? NO_FIXES) : NO_FIXES
}

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

/**
 * One strike per collision where it goes deepest, the selected one marked. A strike shows once Preview reaches the
 * layer it starts on, so the bed is not marked before the part is there; before then the picked one and the one under
 * the pointer in the list show as a faint ghost, to say where to look.
 */
export function strikeMarks(s: Pick<AppState, 'slice' | 'strikePick' | 'strikeHover' | 'layerHi'>): StrikeMark[] {
  const out: StrikeMark[] = []
  collisionsOf(s).forEach((c, i) => {
    const early = s.layerHi - 1 < c.layer
    if (early && s.strikePick !== i && s.strikeHover !== i) return
    out.push({ x: c.worstPoint[0], y: c.worstPoint[1], z: c.worstPoint[2], ...(c.severity === 'close' ? { close: true } : {}), ...(s.strikePick === i ? { selected: true } : {}), ...(early ? { ghost: true } : {}) })
  })
  return out
}
