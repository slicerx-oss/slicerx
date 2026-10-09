// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The outline of a large model's silhouette for the object list (parts.tsx), traced on a grid. Loaded with the first
// model large enough to need it, so it stays out of the app's startup code.
import type { SilhouetteParts } from './parts'

/** Cells across the grid a large model's outline is traced on: twice what the largest thumbnail shows. */
const GRID = 96
/** Raster cells per grid cell along each side: a cell's coverage (0 to 1) is how many of its subcells the model fills. */
const SUB = 2
/** Above this much path text the outline falls back to filled runs of cells (no real model comes near it). */
const MAX_PATH = 400_000

/**
 * A large model's silhouette: its triangles filled into a raster, each GRID cell's coverage traced as a contour at half
 * coverage (marching squares, with the crossings interpolated between cell centers so slopes come out smooth), and
 * each contour simplified to within half a cell (Douglas-Peucker). Holes are contours of their own, filled even-odd.
 */
export function tracedPath(parts: SilhouetteParts, u: number, v: number, ou: number, ov: number, size: number): string {
  const R = GRID * SUB
  const sub = size / R
  const raster = new Uint8Array(R * R)
  const put = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < R && y < R) raster[y * R + x] = 1
  }
  for (const p of parts) {
    const P = p.positions
    const I = p.indices
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t]! * 3
      const b = I[t + 1]! * 3
      const c = I[t + 2]! * 3
      // Raster coordinates of the corners.
      const ax = (P[a + u]! + ou) / sub
      const ay = (ov - P[a + v]!) / sub
      const bx = (P[b + u]! + ou) / sub
      const by = (ov - P[b + v]!) / sub
      const cx = (P[c + u]! + ou) / sub
      const cy = (ov - P[c + v]!) / sub
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
      const x1 = Math.min(R - 1, Math.floor(Math.max(ax, bx, cx)))
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)))
      const y1 = Math.min(R - 1, Math.floor(Math.max(ay, by, cy)))
      // A triangle inside one raster cell (most of them, in a big model) fills that cell.
      if (x0 === x1 && y0 === y1) {
        put(x0, y0)
        continue
      }
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      put(Math.floor(ax), Math.floor(ay))
      if (Math.abs(area) < 1e-12) continue
      // Otherwise every cell whose center is inside it.
      const s = area > 0 ? 1 : -1
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5
          const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * s
          const w1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * s
          const w2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * s
          if (w0 >= 0 && w1 >= 0 && w2 >= 0) raster[y * R + x] = 1
        }
      }
    }
  }
  // Coverage per grid cell, sampled at the cell centers, with a ring of empty samples around so every contour closes.
  const W = GRID + 2
  const field = new Float32Array(W * W)
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      if (raster[y * R + x]) field[(Math.floor(y / SUB) + 1) * W + Math.floor(x / SUB) + 1]! += 1 / (SUB * SUB)
    }
  }
  const cell = size / GRID
  const f = (n: number) => n.toFixed(2)
  let d = ''
  for (const raw of contours(field, W, 0.5)) {
    const loop = simplifyLoop(raw, 0.5)
    if (loop.length < 6) continue
    // Sample (i, j) sits at the center of grid cell (i - 1, j - 1).
    for (let k = 0; k < loop.length; k += 2) d += `${k ? 'L' : 'M'}${f((loop[k]! - 0.5) * cell)} ${f((loop[k + 1]! - 0.5) * cell)}`
    d += 'Z'
  }
  return d.length <= MAX_PATH ? d : runsPath(field, W, cell)
}

/**
 * Closed contours of a W by W field at `level` (marching squares), as flat [x, y, ...] point lists in sample units,
 * each crossing placed by linear interpolation between the two samples it lies between. The field's border must be
 * below the level, so that every contour closes.
 */
export function contours(field: Float32Array, W: number, level: number): number[][] {
  // Each crossing is on an edge between two samples: the horizontal edge (x, y)-(x + 1, y) is 2 * (y * W + x), the
  // vertical edge (x, y)-(x, y + 1) is 2 * (y * W + x) + 1. Each segment joins two edges of its square.
  const at = (x: number, y: number) => field[y * W + x]!
  const point = (e: number): [number, number] => {
    const k = e >> 1
    const x = k % W
    const y = (k - x) / W
    const a = at(x, y)
    const b = e & 1 ? at(x, y + 1) : at(x + 1, y)
    const t = a === b ? 0.5 : (level - a) / (b - a)
    return e & 1 ? [x, y + t] : [x + t, y]
  }
  const next = new Map<number, number[]>()
  const link = (p: number, q: number) => {
    let a = next.get(p)
    if (!a) next.set(p, (a = []))
    a.push(q)
    let b = next.get(q)
    if (!b) next.set(q, (b = []))
    b.push(p)
  }
  for (let y = 0; y + 1 < W; y++) {
    for (let x = 0; x + 1 < W; x++) {
      const top = 2 * (y * W + x)
      const bottom = 2 * ((y + 1) * W + x)
      const left = top + 1
      const right = 2 * (y * W + x + 1) + 1
      const c = (at(x, y) >= level ? 1 : 0) | (at(x + 1, y) >= level ? 2 : 0) | (at(x + 1, y + 1) >= level ? 4 : 0) | (at(x, y + 1) >= level ? 8 : 0)
      if (c === 0 || c === 15) continue
      if (c === 5 || c === 10) {
        // A saddle: the average of the corners decides which corners the inside joins.
        const mid = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 >= level
        if ((c === 5) === mid) {
          link(left, bottom)
          link(top, right)
        } else {
          link(left, top)
          link(right, bottom)
        }
        continue
      }
      const k = c > 7 ? 15 - c : c
      if (k === 1) link(left, top)
      else if (k === 2) link(top, right)
      else if (k === 3) link(left, right)
      else if (k === 4) link(right, bottom)
      else if (k === 6) link(top, bottom)
      else link(left, bottom)
    }
  }
  const out: number[][] = []
  const seen = new Set<number>()
  for (const start of next.keys()) {
    if (seen.has(start)) continue
    const loop: number[] = []
    let prev = -1
    let cur = start
    while (!seen.has(cur)) {
      seen.add(cur)
      loop.push(...point(cur))
      const ns = next.get(cur)!
      const n = ns[0] !== prev ? ns[0]! : (ns[1] ?? ns[0]!)
      prev = cur
      cur = n
    }
    out.push(loop)
  }
  return out
}

/** A closed loop, with the points that lie within `tol` of the outline the others keep dropped (Douglas-Peucker). */
export function simplifyLoop(loop: number[], tol: number): number[] {
  const n = loop.length / 2
  if (n < 4) return loop
  // Split at the point farthest from the first, so the loop is two open polylines.
  let far = 0
  let best = -1
  for (let i = 1; i < n; i++) {
    const d = (loop[2 * i]! - loop[0]!) ** 2 + (loop[2 * i + 1]! - loop[1]!) ** 2
    if (d > best) {
      best = d
      far = i
    }
  }
  const px = (i: number) => loop[2 * (i % n)]!
  const py = (i: number) => loop[2 * (i % n) + 1]!
  const keep = new Uint8Array(n + 1)
  keep[0] = 1
  keep[far] = 1
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const ax = px(a)
    const ay = py(a)
    const dx = px(b) - ax
    const dy = py(b) - ay
    const len = Math.hypot(dx, dy) || 1
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs(dx * (py(i) - ay) - dy * (px(i) - ax)) / len
      if (dist > worst) {
        worst = dist
        at = i
      }
    }
    if (worst > tol) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(px(i), py(i))
  return out
}

/** Filled runs of cells at half coverage or more: the plain fallback for an outline too intricate to trace. */
function runsPath(field: Float32Array, W: number, cell: number): string {
  let d = ''
  const f = (n: number) => (n * cell).toFixed(2)
  for (let y = 1; y + 1 < W; y++) {
    for (let x = 1; x + 1 < W; x++) {
      if (field[y * W + x]! < 0.5) continue
      let e = x
      while (e + 2 < W && field[y * W + e + 1]! >= 0.5) e++
      d += `M${f(x - 1)} ${f(y - 1)}H${f(e)}V${f(y)}H${f(x - 1)}Z`
      x = e
    }
  }
  return d
}
