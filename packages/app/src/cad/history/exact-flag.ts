// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The developer flag for exact solids in history replays (@slicerx/cad-history exact.ts, the B-rep kernel in
// packages/brep). Off unless a developer turns it on with the palette command; it lasts on this device only.
// New lofted bodies on the native engine are asked exact without it (the provider's replays set exactLofts); the flag
// still turns on the whole exact path.
import { get } from '../../state/store'

const KEY = 'sx.exactSolids'

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** True when replays run the steps the kernel has on exact solids: developer mode, with the flag on. */
export function exactSolids(): boolean {
  return get().settingsMode === 'developer' && stored()
}

/** Turns the flag over and says whether it is on now. */
export function toggleExactSolids(): boolean {
  const on = !stored()
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    return false
  }
  return on
}

let fallBacks = 0

/** Counts steps the kernel failed on, which ran on the mesh, and says so in the console: a silent fallback would hide
 * a regression. The step's note says it too. */
export function noteFallBack(steps: number): void {
  fallBacks += steps
  console.warn(`exact solids: ${steps} step(s) ran on the mesh after the kernel failed (${fallBacks} this session)`)
}

export function exactFallBacks(): number {
  return fallBacks
}

const quiet = { count: 0, steps: {} as Record<string, string> }

/**
 * Counts new-body lofts the native engine was asked to make exact without the flag and made as mesh lofts, with each
 * step's latest reason, and says so on the debug console only: the step list and toasts never show it, and a silent
 * fallback would hide a regression. The agent bridge's state reads it (quietLofts).
 */
export function noteQuietLofts(lofts: readonly { step: string; why: string }[]): void {
  for (const l of lofts) quiet.steps[l.step] = l.why
  quiet.count += lofts.length
  console.debug(`exact lofts: ${lofts.length} loft(s) made on the mesh (${quiet.count} this session): ${lofts.map((l) => `${l.step}: ${l.why}`).join('; ')}`)
}

/** The lofts made on the mesh this session (noteQuietLofts), and each step's latest reason. */
export function quietLofts(): { count: number; steps: Record<string, string> } {
  return { count: quiet.count, steps: { ...quiet.steps } }
}
