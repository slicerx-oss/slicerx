// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's gantry in Preview: the beam the engine checks (the profile's rod height and distance), and the gantry
// strikes with the box of the part each one runs through, so the viewport draws that stretch of the beam red.
import type { GantryHit, GantrySpec } from '@slicerx/viewport'
import { resolveConfig } from '../adapters/config'
import type { AppState } from '../state/store'
import { collisionsOf } from './heimdall'
import type { PlateEntry } from '../state/store'
import { apply, bounds } from './transform'

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
    if (!e || !b) continue
    // Red only where the part has material at the height the beam meets it, not across its whole outline.
    const box = sectionBox(e, c.point[2] + 0.5) ?? [b.min[0], b.min[1], b.max[0], b.max[1]]
    out.push({ layers: [c.layer, c.lastLayer], box, top: b.max[2] })
  }
  return out
}

/** The box of the part's cross-section at height `z`, mm, or null where the plane misses it. */
function sectionBox(e: PlateEntry, z: number): [number, number, number, number] | null {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const part of e.parts) {
    const p = part.positions
    const idx = part.indices
    const at = (i: number) => apply(e.transform, [p[3 * i] ?? 0, p[3 * i + 1] ?? 0, p[3 * i + 2] ?? 0])
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const v = [at(idx[t]!), at(idx[t + 1]!), at(idx[t + 2]!)]
      for (let k = 0; k < 3; k++) {
        const a = v[k]!
        const c = v[(k + 1) % 3]!
        if ((a[2] - z) * (c[2] - z) > 0 || a[2] === c[2]) continue
        const f = (z - a[2]) / (c[2] - a[2])
        const x = a[0] + (c[0] - a[0]) * f
        const y = a[1] + (c[1] - a[1]) * f
        b[0] = Math.min(b[0], x)
        b[1] = Math.min(b[1], y)
        b[2] = Math.max(b[2], x)
        b[3] = Math.max(b[3], y)
      }
    }
  }
  return Number.isFinite(b[0]) ? b : null
}
