// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the sheet's drawing shows. A sheet that changes a built design draws that design as it stands on the plate, its
// real mesh in its own frame, so the person sees the part they are editing (the case's base and standoffs, not boxes
// standing in for it). A sheet for a new part draws its own solids. Each row's place is put on the part it draws: places
// given in the sheet's own frame move onto the built part when they miss it, and a row with no place whose value is one
// of the part's overall sizes gets that size's line.
import { bakeMesh } from '@slicerx/cad-history'
import type { PilotDim, PilotDimAt, PilotSheet } from '@slicerx/contracts'
import type { PlateEntry } from '../../state/store'
import { shapeBounds, shapeOfMesh, shapeOfSolids, type Shape, type V3 } from './sheet-draw'

export interface SheetPicture {
  shape: Shape
  /** The rows with their places on this shape. */
  dims: PilotDim[]
  /** Drawn from the design as built, not from the sheet's own solids. */
  built: boolean
}

/** The built design a sheet changes, when it names one that is on the plate. */
export function sheetDesign(sheet: PilotSheet, plate: readonly PlateEntry[]): PlateEntry | null {
  if (!sheet.design) return null
  const e = plate.find((p) => p.id === sheet.design)
  return e && e.parts.some((p) => p.indices.length > 0) ? e : null
}

/** The drawing's part and rows, or null when the sheet has nothing to draw. */
export function sheetPicture(sheet: PilotSheet, plate: readonly PlateEntry[]): SheetPicture | null {
  const e = sheetDesign(sheet, plate)
  if (e) {
    const t = e.transform as Parameters<typeof bakeMesh>[1]
    const shape = shapeOfMesh(e.parts.map((p) => bakeMesh(p, t)))
    const own = sheet.part?.length ? shapeOfSolids(sheet.part) : null
    return { shape, dims: placeMissing(alignDims(sheet.dims, own, shape), shape), built: true }
  }
  if (!sheet.part?.length) return null
  const shape = shapeOfSolids(sheet.part)
  return { shape, dims: placeMissing(sheet.dims, shape), built: false }
}

const plus = (a: V3, s: V3): V3 => [a[0] + s[0], a[1] + s[1], a[2] + s[2]]

/** The points a place pins down on the part: a straight size's ends, an angle's corner. */
const pinsOf = (at: PilotDimAt): V3[] => ('c' in at ? [at.c] : [at.a, at.b])

const moved = (at: PilotDimAt, s: V3): PilotDimAt => ('c' in at ? { ...at, c: plus(at.c, s) } : { ...at, a: plus(at.a, s), b: plus(at.b, s) })

/**
 * Rows placed in another frame than the built part's: mimir often gives places around its own origin, while the built
 * part stands where it landed on the plate. When most places miss the part, they all move by the one shift that puts
 * the sheet's own solids (or, without them, the places themselves) on the part's lowest corner, if that lands more of
 * them on it. Places already on the part stay where they are.
 */
export function alignDims(dims: readonly PilotDim[], own: Shape | null, shape: Shape): PilotDim[] {
  const b = shapeBounds(shape)
  const placed = dims.filter((d) => d.at)
  if (!b || !placed.length) return [...dims]
  const diag = Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2])
  const tol = Math.max(1, diag * 0.03)
  const on = (p: V3): boolean => p.every((v, k) => v >= b.lo[k]! - tol && v <= b.hi[k]! + tol)
  const hits = (s: V3): number => placed.reduce((n, d) => n + (pinsOf(d.at!).every((p) => on(plus(p, s))) ? 1 : 0), 0)
  const now = hits([0, 0, 0])
  if (now * 2 > placed.length) return [...dims]
  const from = (own ? shapeBounds(own) : null)?.lo ?? placed.flatMap((d) => pinsOf(d.at!)).reduce<V3>((lo, p) => [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])], [Infinity, Infinity, Infinity])
  const shift: V3 = [b.lo[0] - from[0], b.lo[1] - from[1], b.lo[2] - from[2]]
  if (hits(shift) <= now) return [...dims]
  return dims.map((d) => (d.at ? { ...d, at: moved(d.at, shift) } : d))
}

/**
 * A row with no place whose value is one of the part's overall sizes (within 2 percent, or half a millimeter) gets that
 * size's line along the part's front bottom edge (length and height, read in Front) or its right edge (depth, read in
 * Top), so its callout shows on the drawing. Each overall size is given once.
 */
export function placeMissing(dims: readonly PilotDim[], shape: Shape): PilotDim[] {
  const b = shapeBounds(shape)
  if (!b) return [...dims]
  const { lo, hi } = b
  const size: V3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
  const gap = Math.max(...size) * 0.08
  const lines: Record<0 | 1 | 2, PilotDimAt> = {
    0: { a: lo, b: [hi[0], lo[1], lo[2]], off: [0, 0, -gap] },
    1: { a: [hi[0], lo[1], lo[2]], b: [hi[0], hi[1], lo[2]], off: [gap, 0, 0] },
    2: { a: lo, b: [lo[0], lo[1], hi[2]], off: [-gap, 0, 0] },
  }
  const used = new Set<number>()
  return dims.map((d) => {
    if (d.at || d.unit !== 'mm') return d
    const axis = ([0, 1, 2] as const)
      .filter((k) => !used.has(k) && Math.abs(size[k] - d.value) <= Math.max(0.5, size[k] * 0.02))
      .sort((p, q) => Math.abs(size[p] - d.value) - Math.abs(size[q] - d.value))[0]
    if (axis === undefined) return d
    used.add(axis)
    return { ...d, at: lines[axis] }
  })
}
