// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// App-level pieces @slicerx/ui does not have: a filament swatch and generated cover art.
import type { CSSProperties } from 'react'

/** A filament color dot. The color is data (a spool's #rrggbb), not a style token. */
export function Swatch({ color, size }: { color: string; size?: 'sm' }) {
  return <i className={size ? `swatch ${size}` : 'swatch'} style={{ '--c': color } as CSSProperties} aria-hidden="true" />
}

const ART_TONES = ['var(--purple)', 'var(--pink)', 'var(--cyan)', 'var(--orange)', 'var(--green)']

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Cover art for a model with no image yet: its silhouette as a stack of print
 * layers, shaped and tinted from the slug, so each listing reads as a distinct object.
 */
export function LayerArt({ seed, layers = 16, muted }: { seed: string; layers?: number; muted?: boolean }) {
  const h = hash(seed)
  // Muted art is one neutral tone, for grids where color would read as decoration.
  const tone = muted ? 'var(--muted)' : (ART_TONES[h % ART_TONES.length] ?? 'var(--purple)')
  const shape = (h >>> 3) % 7
  const scale = 0.7 + ((h >>> 9) % 30) / 100
  const rows = Array.from({ length: layers }, (_, i) => {
    const t = i / (layers - 1)
    const wobble = (((h >>> (i % 24)) & 7) - 3.5) * 0.01
    let w: number
    switch (shape) {
      case 0: w = Math.sin(Math.PI * (0.06 + t * 0.88)); break // sphere
      case 1: w = 0.3 + 0.62 * (1 - t); break // cone
      case 2: w = t < 0.18 ? 0.95 : 0.4; break // base and post
      case 3: w = 0.55 + 0.3 * Math.sin(t * Math.PI * 2); break // vase
      case 4: w = 0.45 + 0.5 * t * t; break // bowl
      case 5: w = t > 0.8 ? 0.8 - (t - 0.8) * 2 : 0.8; break // box with a rounded top
      default: w = 0.3 + 0.6 * Math.abs(t - 0.5) * 2 // hourglass
    }
    return Math.max(0.12, Math.min(0.96, w * scale + wobble))
  })
  return (
    <span className="layer-art" style={{ '--tone': tone } as CSSProperties} aria-hidden="true">
      {rows.map((w, i) => (
        <i key={i} style={{ width: `${Math.round(w * 100)}%`, opacity: 0.35 + (i / layers) * 0.65 }} />
      ))}
    </span>
  )
}

/** Up to this many triangles a silhouette is drawn triangle by triangle; above, it is traced on a grid. */
const WHOLE_MAX = 5_000
/** Cells across the grid a large model's outline is traced on: twice what the largest thumbnail shows. */
const GRID = 96

type SilhouetteParts = readonly { positions: Float32Array; indices: Uint32Array }[]

const drawn = new WeakMap<SilhouetteParts, { d: string; size: number; evenOdd?: boolean }>()

/**
 * A model's silhouette, drawn from its triangles and seen along its thinnest axis, so flat parts show their outline.
 * A model of up to WHOLE_MAX triangles is drawn whole; the outline of a larger one is traced on a grid (tracedPath),
 * since a path through millions of triangles is hundreds of megabytes of text for a thumbnail. Kept per parts array, so the
 * object list does not draw it again on every render.
 */
export function Silhouette({ parts }: { parts: SilhouetteParts }) {
  let sil = drawn.get(parts)
  if (!sil) {
    sil = silhouettePath(parts)
    drawn.set(parts, sil)
  }
  const { d, size, evenOdd } = sil
  return (
    <svg className="silhouette" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <path d={d} {...(evenOdd ? { fillRule: 'evenodd' as const } : {})} />
    </svg>
  )
}

/** The silhouette's path, the size of its square view box, and whether its holes are filled even-odd. */
export function silhouettePath(parts: SilhouetteParts): { d: string; size: number; evenOdd?: boolean } {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let triangles = 0
  for (const p of parts) {
    triangles += Math.floor(p.indices.length / 3)
    for (let i = 0; i + 2 < p.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p.positions[i + a] ?? 0
        if (v < lo[a]!) lo[a] = v
        if (v > hi[a]!) hi[a] = v
      }
    }
  }
  if (!(lo[0]! <= hi[0]!)) return { d: '', size: 1 }
  const ext = [0, 1, 2].map((a) => (hi[a] ?? 0) - (lo[a] ?? 0))
  const thin = ext.indexOf(Math.min(...ext))
  // Horizontal axis is X unless X is the thin one; vertical is Z unless Z is (then Y, seen from above).
  const u = thin === 0 ? 1 : 0
  const v = thin === 2 ? 1 : 2
  const size = Math.max(ext[u] ?? 1, ext[v] ?? 1, 1)
  const ou = (size - (ext[u] ?? 0)) / 2 - (lo[u] ?? 0)
  const ov = (size - (ext[v] ?? 0)) / 2 + (hi[v] ?? 0)
  if (triangles > WHOLE_MAX) return { d: tracedPath(parts, u, v, ou, ov, size), size, evenOdd: true }
  let d = ''
  for (const p of parts) {
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      const pts = [p.indices[t] ?? 0, p.indices[t + 1] ?? 0, p.indices[t + 2] ?? 0].map((i) => [(p.positions[i * 3 + u] ?? 0) + ou, ov - (p.positions[i * 3 + v] ?? 0)] as const)
      const [a, b, c] = pts as [readonly [number, number], readonly [number, number], readonly [number, number]]
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
      if (Math.abs(cross) < 1e-6) continue
      // One winding for every triangle, so overlapping faces fill instead of canceling.
      const [p1, p2] = cross > 0 ? [b, c] : [c, b]
      d += `M${a[0].toFixed(2)} ${a[1].toFixed(2)}L${p1[0].toFixed(2)} ${p1[1].toFixed(2)}L${p2[0].toFixed(2)} ${p2[1].toFixed(2)}Z`
    }
  }
  return { d, size }
}

/** Raster cells per grid cell along each side: a cell's coverage (0 to 1) is how many of its subcells the model fills. */
const SUB = 2
/** Above this much path text the outline falls back to filled runs of cells (no real model comes near it). */
const MAX_PATH = 400_000

/**
 * A large model's silhouette: its triangles filled into a raster, each GRID cell's coverage traced as a contour at half
 * coverage (marching squares, with the crossings interpolated between cell centers so slopes come out smooth), and
 * each contour simplified to within half a cell (Douglas-Peucker). Holes are contours of their own, filled even-odd.
 */
function tracedPath(parts: SilhouetteParts, u: number, v: number, ou: number, ov: number, size: number): string {
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
