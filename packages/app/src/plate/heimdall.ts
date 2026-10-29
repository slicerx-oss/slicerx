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

/**
 * The plate object a collision strikes, or null when it names none on the plate: the engine's `damagedId`, and for an
 * older engine the part the machine meets, the later of two whose paths cross (the one printing), or the one printing
 * into a keep-out zone.
 */
export function damagedOf(s: Pick<AppState, 'plate'>, c: Pick<Collision, 'kind' | 'objectId' | 'hitId' | 'damagedId'>): string | null {
  const on = (id: string | undefined) => (id && s.plate.some((p) => p.id === id) ? id : null)
  if (c.damagedId !== undefined) return on(c.damagedId)
  if (c.kind === 'keep_out') return on(c.objectId)
  if (c.kind === 'path_conflict') return on(c.objectId) ?? on(c.hitId)
  return on(c.hitId)
}

/**
 * What the view draws for a picked strike: an outline round the part it hits, the region struck, mm, and the paths it
 * keeps in full: the struck object's (its index in the slice request, which is the plate's printable entries in order)
 * over the region's layers. Every other path fades back. Without a current slice nothing fades.
 */
export interface CollisionHighlight {
  outline: string[]
  box: { min: [number, number, number]; max: [number, number, number] } | null
  focus: { object: number; z: [number, number] | null } | null
}

/**
 * The picked strike's highlight while its parts are the selection, in Slice: the part it hits outlined, and the region
 * struck filled (in the engine's coordinates, as the strike marks are). A close call is not a hit, so it has none. The
 * outline rides with a part moved since the slice; the region, from before it moved, goes.
 */
export function collisionHighlight(s: Pick<AppState, 'slice' | 'strikePick' | 'plate' | 'selection' | 'selectedIds' | 'workspace' | 'modelMode'>): CollisionHighlight | null {
  if (s.strikePick === null || s.workspace !== 'prepare' || s.modelMode !== 'slice' || s.slice.status !== 'done') return null
  const c = collisionsOf(s)[s.strikePick]
  if (!c || c.severity !== 'hit') return null
  const parts = collisionParts(s, c)
  const selected = new Set(s.selectedIds)
  if (s.selection !== null) selected.add(s.selection)
  if (parts.length === 0 || selected.size !== parts.length || !parts.every((id) => selected.has(id))) return null
  const damaged = damagedOf(s, c)
  if (!damaged) return null
  const box = !s.slice.stale && c.contactMin && c.contactMax ? { min: c.contactMin, max: c.contactMax } : null
  const object = s.plate.filter((p) => p.printable !== false).findIndex((p) => p.id === damaged)
  const focus = !s.slice.stale && object >= 0 ? { object, z: box ? ([box.min[2], box.max[2]] as [number, number]) : null } : null
  return { outline: [damaged], box, focus }
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
