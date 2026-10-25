// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shape of a bed. A delta printer's `printable_area` is a ring of points (Orca writes 72 of them around the
// build circle), not a rectangle, so the viewport, arrange and the off-bed check read the circle rather than its
// bounding box. A bed is a circle when the area's points sit on one circle and its box is square.
import type { Bed } from '@slicerx/contracts'
import type { Circle } from '@slicerx/settings/box-pack'
import { point } from './bed-origin'

// The box packer's bed checks (@slicerx/settings/box-pack), shared with the MCP server's arrange.
export { bedCircle, boxInBed, type Circle } from '@slicerx/settings/box-pack'

/** Fewest points that read as a circle: a square or an octagon cut from a rectangle printer stays a rectangle. */
const MIN_RING_POINTS = 12
/** How far a point may sit from the mean radius, as a fraction of it. */
const RING_TOLERANCE = 0.02

/** The circle a printable area traces, in the area's own coordinates, or null for any other shape. */
export function circleOfArea(area: unknown): Circle | null {
  const items = typeof area === 'string' ? area.split(',') : Array.isArray(area) ? (area as unknown[]) : []
  const pts = items.map(point).filter((p): p is [number, number] => p !== null)
  if (pts.length < MIN_RING_POINTS) return null
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const w = Math.max(...xs) - Math.min(...xs)
  const d = Math.max(...ys) - Math.min(...ys)
  if (!(w > 0) || Math.abs(w - d) > w * RING_TOLERANCE) return null
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2
  const radii = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy))
  const r = radii.reduce((a, b) => a + b, 0) / radii.length
  if (radii.some((x) => Math.abs(x - r) > r * RING_TOLERANCE)) return null
  return { cx, cy, r: Math.max(w, d) / 2 }
}

/** A ring of points around a circle of `diameter` mm whose box starts at 0, 0: the printable area of a round bed. */
export function circleArea(diameter: number, points = 72): [number, number][] {
  const r = diameter / 2
  return Array.from({ length: points }, (_, i) => {
    const a = (i / points) * Math.PI * 2
    return [round3(r + r * Math.cos(a)), round3(r + r * Math.sin(a))] as [number, number]
  })
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

