// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The smallest hole a printer makes and the longest thread a hole or rod takes, in the words the hole and thread
// tools show. The app's tools and the MCP tools refuse with these same sentences before the engine runs: the engine
// takes any diameter above 0, and cuts a thread longer than its hole down to the hole without a word.
import type { ThreadPlace } from './types'

const mm = (v: number) => `${Number(v.toFixed(2))} mm`

/** Why a hole of this diameter can't be made, or null: a hole narrower than the nozzle closes up as it prints. */
export function customHoleProblem(diameterMm: number, nozzleMm: number): string | null {
  return diameterMm < nozzleMm ? `The diameter is too small to print with a ${nozzleMm} mm nozzle. The smallest is ${nozzleMm} mm.` : null
}

/**
 * What is wrong with a typed thread length, or null when it can run (no length is the whole length). The engine
 * would quietly cut a longer one to the hole's depth or the rod's length, so the most is said here instead.
 */
export function threadLengthProblem(lengthMm: number | undefined, target: Pick<ThreadPlace, 'lengthMm' | 'internal'>): string | null {
  if (lengthMm === undefined) return null
  if (!Number.isFinite(lengthMm)) return 'Type a number for the length, or leave it empty for the whole length.'
  if (lengthMm <= 0) return 'The length must be more than 0 mm.'
  if (lengthMm > target.lengthMm + 1e-6) return `The length is more than the ${target.internal ? 'hole is deep' : 'rod is long'}. The most is ${mm(target.lengthMm)}.`
  return null
}
