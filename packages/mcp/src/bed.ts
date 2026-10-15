// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The bed a project's printer settings describe: the box of `printable_area` and, for a delta, the circle it traces.
// A delta's printable area is a ring of points (72 for the FLSUN V400), so the plate layout keeps every part inside
// the circle rather than its bounding square, and a client reads the shape back from the project.
import type { SettingValue } from '@slicerx/contracts'

export interface BedArea {
  /** The box of the printable area: front left corner, size and printable height, mm. */
  x0: number
  y0: number
  widthMm: number
  depthMm: number
  heightMm: number
  /** The circle of a round bed (a delta), or undefined for any other shape. */
  circle?: { cx: number; cy: number; r: number }
}

/** Fewest points that read as a circle: a square or an octagon cut from a rectangle printer stays a rectangle. */
const MIN_RING_POINTS = 12
/** How far a point may sit from the mean radius, as a fraction of it. */
const RING_TOLERANCE = 0.02

function points(area: SettingValue | undefined): [number, number][] {
  const items: unknown[] = Array.isArray(area) ? area : typeof area === 'string' ? area.split(',') : []
  return items.flatMap((p) => {
    const xy = Array.isArray(p) ? p : typeof p === 'string' ? p.split('x') : []
    const [x, y] = xy.map(Number)
    return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? [[x, y] as [number, number]] : []
  })
}

function scalar(v: SettingValue | undefined): number | undefined {
  const x = Array.isArray(v) ? v[0] : v
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** The bed of `config`. Without a printable area of three points or more, the 256 mm square the engine defaults to. */
export function bedArea(config: Record<string, SettingValue>): BedArea {
  const heightMm = scalar(config['printable_height']) ?? 250
  const pts = points(config['printable_area'])
  if (pts.length < 3) return { x0: 0, y0: 0, widthMm: 256, depthMm: 256, heightMm }
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const widthMm = Math.max(...xs) - x0
  const depthMm = Math.max(...ys) - y0
  const bed: BedArea = { x0, y0, widthMm, depthMm, heightMm }
  if (pts.length < MIN_RING_POINTS || !(widthMm > 0) || Math.abs(widthMm - depthMm) > widthMm * RING_TOLERANCE) return bed
  const cx = x0 + widthMm / 2
  const cy = y0 + depthMm / 2
  const radii = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy))
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length
  if (radii.some((x) => Math.abs(x - mean) > mean * RING_TOLERANCE)) return bed
  return { ...bed, circle: { cx, cy, r: Math.max(widthMm, depthMm) / 2 } }
}

const mm = (v: number): number => Math.round(v * 100) / 100

/** The bed as a client reads it back: a round bed by its diameter, any other by its width and depth. */
export function describeBed(bed: BedArea): Record<string, unknown> {
  return bed.circle
    ? { shape: 'round', diameterMm: mm(bed.circle.r * 2), heightMm: mm(bed.heightMm), centerMm: [mm(bed.circle.cx), mm(bed.circle.cy)] }
    : { shape: 'rectangle', widthMm: mm(bed.widthMm), depthMm: mm(bed.depthMm), heightMm: mm(bed.heightMm), originMm: [mm(bed.x0), mm(bed.y0)] }
}

/** Room between copies in the automatic rows, mm. */
export const GAP_MM = 5
/** Room a row leaves at each side of the bed, for a skirt or brim around the parts at its ends. */
export const EDGE_MM = 10

/** The footprint of one copy in the automatic rows, after its rotation and scale, mm. */
export interface Foot {
  w: number
  d: number
}

/** A footprint's box on the bed, mm in bed coordinates. */
export interface FootBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * True when a footprint reaches past the rim of a round bed: its farthest corner is more than the radius from the
 * middle. The same 0.01 mm tolerance as the app's off-bed check, so 1 mm past the rim is off the bed and 1 mm inside
 * is on it.
 */
export function pastRim(c: { cx: number; cy: number; r: number }, box: FootBox): boolean {
  const dx = Math.max(Math.abs(box.x0 - c.cx), Math.abs(box.x1 - c.cx))
  const dy = Math.max(Math.abs(box.y0 - c.cy), Math.abs(box.y1 - c.cy))
  return Math.hypot(dx, dy) > c.r + 0.01
}

/**
 * Where each copy's front left corner goes on a rectangular bed: rows that end before the edge room at either side
 * (a part wider than that still gets a row), the whole layout then moved to the middle of the printable area.
 */
export function boxRows(feet: readonly Foot[], bed: BedArea, edge = EDGE_MM, gap = GAP_MM): [number, number][] {
  const rowWidth = bed.widthMm - 2 * edge
  const out: [number, number][] = []
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  let x = 0
  let y = 0
  let rowDepth = 0
  for (const f of feet) {
    if (x > 0 && x + f.w > rowWidth) {
      x = 0
      y += rowDepth + gap
      rowDepth = 0
    }
    out.push([x, y])
    box.x0 = Math.min(box.x0, x)
    box.y0 = Math.min(box.y0, y)
    box.x1 = Math.max(box.x1, x + f.w)
    box.y1 = Math.max(box.y1, y + f.d)
    x += f.w + gap
    rowDepth = Math.max(rowDepth, f.d)
  }
  if (!out.length) return out
  const dx = bed.x0 + bed.widthMm / 2 - (box.x0 + box.x1) / 2
  const dy = bed.y0 + bed.depthMm / 2 - (box.y0 + box.y1) / 2
  return out.map(([px, py]) => [px + dx, py + dy])
}

/**
 * Where each copy's front left corner goes on a round bed. Rows run front to back from where a stack of their height
 * would be centered; a row takes parts while it is no wider than the circle, less the edge room, at the row's edge
 * farthest from the middle, and is centered across. The stack's height depends on how the rows fill, so the rows are
 * laid again from the height found until it holds (a few passes); every row is checked where it ends up.
 */
export function roundRows(feet: readonly Foot[], c: { cx: number; cy: number; r: number }, edge = EDGE_MM, gap = GAP_MM): [number, number][] {
  const room = c.r - edge
  const chord = (ya: number, yb: number): number => {
    const far = Math.max(Math.abs(ya - c.cy), Math.abs(yb - c.cy))
    return far >= room ? 0 : 2 * Math.sqrt(room * room - far * far)
  }
  const lay = (top: number): { spots: [number, number][]; height: number } => {
    const rows: { items: number[]; width: number; depth: number; y: number }[] = []
    let row = { items: [] as number[], width: 0, depth: 0, y: top }
    feet.forEach((f, k) => {
      const width = row.items.length ? row.width + gap + f.w : f.w
      const depth = Math.max(row.depth, f.d)
      if (row.items.length && width > chord(row.y, row.y + depth)) {
        rows.push(row)
        row = { items: [k], width: f.w, depth: f.d, y: row.y + row.depth + gap }
        return
      }
      row = { ...row, items: [...row.items, k], width, depth }
    })
    if (row.items.length) rows.push(row)
    const spots: [number, number][] = feet.map(() => [0, 0])
    for (const rw of rows) {
      let x = c.cx - rw.width / 2
      for (const k of rw.items) {
        spots[k] = [x, rw.y]
        x += feet[k]!.w + gap
      }
    }
    const last = rows[rows.length - 1]
    return { spots, height: last ? last.y + last.depth - top : 0 }
  }
  let height = 0
  let best = lay(c.cy)
  for (let pass = 0; pass < 8 && Math.abs(best.height - height) >= 1e-6; pass++) {
    height = best.height
    best = lay(c.cy - height / 2)
  }
  return best.spots
}
