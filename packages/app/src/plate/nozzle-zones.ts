// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Dual nozzle printers: the strips of the bed only one nozzle reaches. Bambu Studio keeps one printable area per
// extruder (`extruder_printable_area`, PrintConfig.cpp) and treats the overlap as the shared area
// (Print::get_extruder_shared_printable_polygon); what lies outside an extruder's area is unreachable for it
// (get_extruder_unprintable_polygons). The areas come from the printer profile's `extruder_printable_area`
// (packages/profiles/machine.json), so any profile carrying the key gets its zones.
import type { NozzleZone } from '@slicerx/viewport'
import type { Bed } from '@slicerx/contracts'

/** One polygon per extruder in bed coordinates (mm). */
export type ExtruderArea = [number, number][]

/** Tints per side, from the Nocturne palette. */
export const ZONE_COLORS = { first: '#8be9fd', second: '#ffb86c' } as const

export interface ZoneInfo extends NozzleZone {
  /** What stands in the tooltip: who can reach it and who cannot. */
  body: string
}

/** Orca's format for one area: points as `x` and `y` joined by `x`, separated by commas ("0x0,325x0,325x320,0x320"). */
export function parseArea(text: unknown): ExtruderArea | null {
  if (typeof text !== 'string') return null
  const pts = text.split(',').map((p) => {
    const [x, y] = p.split('x').map(Number)
    return [x, y] as [number, number]
  })
  return pts.length >= 3 && pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) ? pts : null
}

/** The areas of the printer's profile, or an empty list when it has fewer than two (a single nozzle). */
export async function loadExtruderAreas(printerId: string | null): Promise<ExtruderArea[]> {
  if (!printerId) return []
  const { machineEntry } = await import('@slicerx/settings')
  const raw = machineEntry(printerId)?.machine['extruder_printable_area']
  if (!Array.isArray(raw) || raw.length < 2) return []
  const areas = raw.map(parseArea)
  return areas.every((a): a is ExtruderArea => a !== null) ? areas : []
}

const box = (a: ExtruderArea) => ({
  x0: Math.min(...a.map((p) => p[0])),
  x1: Math.max(...a.map((p) => p[0])),
  y0: Math.min(...a.map((p) => p[1])),
  y1: Math.max(...a.map((p) => p[1])),
})

/** Areas only one nozzle reaches, for two rectangular extruder areas side by side; empty otherwise. */
export function nozzleZones(areas: readonly ExtruderArea[], bed: Bed): ZoneInfo[] {
  if (areas.length !== 2) return []
  const [p, q] = [box(areas[0] as ExtruderArea), box(areas[1] as ExtruderArea)]
  // The area that starts further left (or lower) is the left (front) nozzle.
  const leftFirst = p.x0 <= q.x0
  const [l, r] = leftFirst ? [p, q] : [q, p]
  const out: ZoneInfo[] = []
  const strip = (id: string, who: string, other: string, color: string, x0: number, x1: number, y0: number, y1: number) => {
    const c = { x0: Math.max(0, x0), x1: Math.min(bed.widthMm, x1), y0: Math.max(0, y0), y1: Math.min(bed.depthMm, y1) }
    if (c.x1 - c.x0 < 0.5 || c.y1 - c.y0 < 0.5) return
    out.push({
      id,
      label: `${who} only`,
      color,
      polygon: [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]],
      body: `Only the ${who.toLowerCase()} reaches this ${(c.x1 - c.x0).toFixed(0)} mm strip. The ${other.toLowerCase()} cannot print here.`,
    })
  }
  strip('zone-left', 'Left nozzle', 'right nozzle', ZONE_COLORS.first, l.x0, r.x0, l.y0, l.y1)
  strip('zone-right', 'Right nozzle', 'left nozzle', ZONE_COLORS.second, l.x1, r.x1, r.y0, r.y1)
  return out
}
