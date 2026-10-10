// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The prime tower's place. Auto is on by default: the engine picks a spot clear of the objects and reports it
// (SliceResult.primeTower). Moving the tower by hand turns auto off and sends the spot as wipe_tower_x and wipe_tower_y.
import type { PrimeTowerPlacement } from '@slicerx/contracts'
import { get, markStale, set } from '../state/store'

export const TOWER_ID = 'prime-tower'

export function setTowerAuto(on: boolean): void {
  const s = get()
  // Turning auto off keeps the tower where it stands now, so nothing jumps.
  const reported = s.slice.status === 'done' ? s.slice.result.primeTower : undefined
  set({ tower: on ? { ...s.tower, auto: true } : { auto: false, x: reported?.x ?? s.tower.x, y: reported?.y ?? s.tower.y } })
  markStale()
}

/** A hand move: the new front left corner, mm. Turns auto off. */
export function moveTower(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  set({ tower: { auto: false, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }, towerFromProject: false })
  markStale()
}

/** Where the tower is drawn: the engine's report, or the hand placed corner once auto is off. */
export function towerPlacement(s: Pick<ReturnType<typeof get>, 'slice' | 'tower'>): PrimeTowerPlacement | null {
  if (s.slice.status !== 'done') return null
  const r = s.slice.result.primeTower
  if (!r) return null
  return s.tower.auto ? r : { ...r, x: s.tower.x, y: s.tower.y, reason: 'kept' }
}

/** A short note when the engine did not put a user set tower where it was asked, else null. Never an error. */
export function towerNote(r: PrimeTowerPlacement | undefined, auto: boolean): string | null {
  if (!r || auto) return null
  switch (r.reason) {
    case 'moved_onto_bed': return 'atlas moved the prime tower back onto the bed.'
    case 'moved_clear': return 'atlas moved the prime tower to the nearest spot clear of the objects.'
    case 'reshaped': return 'atlas made the prime tower wider and shallower so it fits.'
    default: return null
  }
}

/** The tower the plate view draws, with its height. */
export interface ShownTower {
  at: PrimeTowerPlacement
  heightMm: number
}

/**
 * What the plate view draws: the finished slice's tower, or the one drawn before while a new slice runs (at the hand
 * placed corner once auto is off), so an edit does not drop the tower and bring it back, a scene rebuild each time.
 */
export function towerShown(s: Pick<ReturnType<typeof get>, 'slice' | 'tower'>, before: ShownTower | null): ShownTower | null {
  if (s.slice.status === 'running') return before && !s.tower.auto ? { ...before, at: { ...before.at, x: s.tower.x, y: s.tower.y } } : before
  const at = towerPlacement(s)
  if (!at || s.slice.status !== 'done') return null
  const z = s.slice.result.layerZ
  return { at, heightMm: z?.length ? (z[z.length - 1] as number) : 10 }
}

/** The tower as a box for the 3D view: local corner at the origin, so the transform is the corner and the angle. */
export function towerMesh(p: PrimeTowerPlacement, heightMm: number): { positions: Float32Array; indices: Uint32Array; transform: number[] } {
  const w = p.width
  const d = p.depth
  const h = Math.max(0.2, heightMm)
  const positions = new Float32Array([0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  const a = (p.angle * Math.PI) / 180
  const c = Math.cos(a)
  const sn = Math.sin(a)
  return { positions, indices, transform: [c, sn, 0, 0, -sn, c, 0, 0, 0, 0, 1, 0, p.x, p.y, 0, 1] }
}
