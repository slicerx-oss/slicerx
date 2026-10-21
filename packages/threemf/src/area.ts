// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printable area's front left corner: where the plate's 0, 0 sits on the machine. A bed whose printable area starts
// elsewhere (Snapmaker U1 at 0.5, 1; a delta centered on 0, 0) is shifted by it where the plate meets the printer.

export type Origin = readonly [number, number]

/** A point of a printable area, as `[x, y]` or Orca's `"XxY"` text, or null. */
export function point(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2) {
    const x = Number(v[0])
    const y = Number(v[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  if (typeof v === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*x\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*$/i.exec(v)
    if (m) return [Number(m[1]), Number(m[2])]
  }
  return null
}

/** The front left corner of a printable area in machine coordinates: where the plate's 0, 0 sits on the machine. */
export function areaOrigin(area: unknown): Origin {
  const items = typeof area === 'string' ? area.split(',') : Array.isArray(area) ? (area as unknown[]) : []
  const pts = items.map(point).filter((p): p is [number, number] => p !== null)
  if (pts.length < 3) return [0, 0]
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))]
}
