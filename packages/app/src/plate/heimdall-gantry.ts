// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's gantry in Preview: the beam the engine checks (the profile's rod height and distance), and the gantry
// strikes with the box of the part each one runs through, so the viewport draws that stretch of the beam red.
import type { GantryHit, GantrySpec } from '@slicerx/viewport'
import { resolveConfig } from '../adapters/config'
import type { AppState } from '../state/store'
import { collisionsOf } from './heimdall'
import { bounds } from './transform'

/** Printers whose bed moves in y under a gantry on two uprights, where the profile does not say (`printer_structure`). */
const SLINGER = /^(bambu-a1|prusa-(mk|mini)|creality-ender|elegoo-neptune)/
/** Deltas have no gantry beam. */
const DELTA = /^flsun-/

const num = (v: unknown): number => {
  const n = Number(Array.isArray(v) ? v[0] : v)
  return Number.isFinite(n) ? n : 0
}

/** The beam for the printer in use, or null when its profile gives no rod height. */
export function gantrySpec(s: Pick<AppState, 'profile' | 'easy' | 'overrides' | 'bed'>): GantrySpec | null {
  if (!s.profile) return null
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, unknown>
  const rod = num(cfg['extruder_clearance_height_to_rod'])
  const structure = String(cfg['printer_structure'] ?? '')
  if (rod <= 0 || structure === 'delta' || DELTA.test(s.profile.printerId)) return null
  const slinger = structure === 'i3' || SLINGER.test(s.profile.printerId)
  return { rod, reach: num(cfg['extruder_clearance_dist_to_rod']), width: s.bed.widthMm, slinger }
}

/** The gantry strikes of the slice on screen, each with the box of the part it runs through. */
export function gantryHits(s: Pick<AppState, 'slice' | 'plate'>): GantryHit[] {
  const out: GantryHit[] = []
  for (const c of collisionsOf(s)) {
    if (c.kind !== 'gantry' || c.part !== 'gantry' || c.severity !== 'hit') continue
    const e = s.plate.find((p) => p.id === c.hitId)
    const b = e ? bounds(e.parts, e.transform) : null
    if (!b) continue
    out.push({ layers: [c.layer, c.lastLayer], box: [b.min[0], b.min[1], b.max[0], b.max[1]], top: b.max[2] })
  }
  return out
}
