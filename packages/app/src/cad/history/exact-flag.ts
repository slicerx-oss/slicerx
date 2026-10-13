// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The developer flag for exact solids in history replays (@slicerx/cad-history exact.ts, the B-rep kernel in
// packages/brep). Off unless a developer turns it on with the palette command; it lasts on this device only.
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
