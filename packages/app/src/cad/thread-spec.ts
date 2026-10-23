// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the thread tool asks the engine for: an ISO coarse thread (sx-geom thread.rs) with the fit's clearance a
// side, at most a quarter of the pitch so the flanks keep their shape, and words that say the size, where it goes,
// the clearance and the layer height the flanks need. The sizes are the ISO ones; how they fit once printed is
// not yet checked by a test print, and the words say so.
import type { ThreadSpec, ThreadTarget } from '../geom/cad'
import type { Clearance } from '../plate/clearance'

const mm = (v: number) => `${Number(v.toFixed(2))} mm`

export function threadSpecFor(target: ThreadTarget, choice: { size: string; lengthMm?: number }, fit: Clearance): { spec: ThreadSpec; label: string; words: string[] } {
  const size = target.sizes.find((s) => s.name === choice.size) ?? target.sizes.find((s) => s.name === target.suggested) ?? target.sizes[0]!
  const most = size.pitchMm / 4
  const clearanceMm = Math.min(fit.mm, most)
  const shorter = choice.lengthMm !== undefined && Number.isFinite(choice.lengthMm) && choice.lengthMm > 0 && choice.lengthMm < target.lengthMm
  const spec: ThreadSpec = { size: size.name, clearanceMm, ...(shorter ? { lengthMm: choice.lengthMm } : {}) }
  // The engine stops half a pitch short of a closed end.
  const whole = target.openEnd ? target.lengthMm : target.lengthMm - size.pitchMm / 2
  const where = target.internal ? 'in the hole' : 'on the outside'
  const words = [
    `${size.name} x ${size.pitchMm} ${where}, ${mm(shorter ? choice.lengthMm! : whole)} long.`,
    fit.mm > most ? `Clearance ${clearanceMm.toFixed(2)} mm a side, the most an ${size.name} thread takes.` : `Clearance ${fit.words}`,
    `Print at ${(size.pitchMm / 4).toFixed(2)} mm layers or finer so the flanks come out clean.`,
    'ISO sizes; the printed fit is not yet checked by a test print.',
  ]
  return { spec, label: `${size.name} thread`, words }
}
