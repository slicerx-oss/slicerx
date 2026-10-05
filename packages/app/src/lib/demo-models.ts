// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Example models built in code, so a fresh install has something to slice
// without shipping mesh files: the layered X, a calibration cube, a wall
// hook, a cable clip and a shelf bracket. Each is a 2D outline extruded in Z.
import type { MeshPart } from '@slicerx/contracts'
import { brandAccent } from '../edition'

type Pt = [number, number]

export interface DemoModel {
  slug: string
  name: string
  /** Short description for the library. */
  note: string
  build(): { parts: MeshPart[]; colors: string[] }
}

/** Twice the signed area; positive for counterclockwise outlines. */
function area2(poly: readonly Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i] ?? [0, 0]
    const [x1, y1] = poly[(i + 1) % poly.length] ?? [0, 0]
    a += x0 * y1 - x1 * y0
  }
  return a
}

function inTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const s = (u: Pt, v: Pt, w: Pt) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
  const d1 = s(a, b, p)
  const d2 = s(b, c, p)
  const d3 = s(c, a, p)
  return d1 >= 0 && d2 >= 0 && d3 >= 0
}

/** Ear clipping for a simple counterclockwise polygon. Returns index triples. */
function triangulate(poly: readonly Pt[]): number[] {
  const idx = poly.map((_, i) => i)
  const out: number[] = []
  let guard = 0
  while (idx.length > 3 && guard++ < 10_000) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length] ?? 0
      const ib = idx[i] ?? 0
      const ic = idx[(i + 1) % idx.length] ?? 0
      const a = poly[ia] ?? [0, 0]
      const b = poly[ib] ?? [0, 0]
      const c = poly[ic] ?? [0, 0]
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0) continue
      if (idx.some((j) => j !== ia && j !== ib && j !== ic && inTriangle(poly[j] ?? [0, 0], a, b, c))) continue
      out.push(ia, ib, ic)
      idx.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) break
  }
  if (idx.length === 3) out.push(idx[0] ?? 0, idx[1] ?? 0, idx[2] ?? 0)
  return out
}

/** Extrudes an outline (mm) from z0 to z1 into a closed part. */
function extrude(name: string, slot: number, outline: readonly Pt[], z0: number, z1: number): MeshPart {
  const poly = area2(outline) < 0 ? [...outline].reverse() : [...outline]
  const n = poly.length
  const positions = new Float32Array(n * 2 * 3)
  poly.forEach(([x, y], i) => {
    positions.set([x, y, z0], i * 3)
    positions.set([x, y, z1], (n + i) * 3)
  })
  const caps = triangulate(poly)
  const indices: number[] = []
  for (let t = 0; t < caps.length; t += 3) {
    const a = caps[t] ?? 0
    const b = caps[t + 1] ?? 0
    const c = caps[t + 2] ?? 0
    indices.push(c, b, a, n + a, n + b, n + c)
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    indices.push(i, j, n + j, i, n + j, n + i)
  }
  return { name, slot, positions, indices: Uint32Array.from(indices) }
}

/**
 * Stands an extruded part up: the outline moves to the XZ plane and the
 * extrusion becomes the depth in Y, centered. Swapping two axes mirrors the
 * mesh, so the triangle winding is flipped back.
 */
function standUp(part: MeshPart, lift: number): MeshPart {
  const src = part.positions
  const positions = new Float32Array(src.length)
  let zMin = Infinity
  let depth = 0
  for (let i = 0; i < src.length; i += 3) {
    zMin = Math.min(zMin, src[i + 1] ?? 0)
    depth = Math.max(depth, src[i + 2] ?? 0)
  }
  for (let i = 0; i < src.length; i += 3) {
    positions[i] = src[i] ?? 0
    positions[i + 1] = (src[i + 2] ?? 0) - depth / 2
    positions[i + 2] = (src[i + 1] ?? 0) - zMin + lift
  }
  const indices = new Uint32Array(part.indices.length)
  for (let t = 0; t < part.indices.length; t += 3) {
    indices[t] = part.indices[t] ?? 0
    indices[t + 1] = part.indices[t + 2] ?? 0
    indices[t + 2] = part.indices[t + 1] ?? 0
  }
  return { ...part, positions, indices }
}

function rect(w: number, d: number): Pt[] {
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ]
}

function arc(cx: number, cy: number, r: number, from: number, to: number, steps: number): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / steps
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as Pt
  })
}

/** The X of the mark on a 32-unit grid, as in the logo, centered and scaled to `size` mm. */
function xOutline(size: number): Pt[] {
  const pts: Pt[] = [[4.5, 4], [10.7, 4], [16, 12.1], [21.3, 4], [27.5, 4], [19.2, 16], [27.5, 28], [21.3, 28], [16, 19.9], [10.7, 28], [4.5, 28], [12.8, 16]]
  const k = size / 24
  return pts.map(([x, y]) => [(x - 16) * k, (16 - y) * k])
}

export const DEMO_MODELS: readonly DemoModel[] = [
  {
    slug: 'x-mark',
    name: 'Layered X',
    note: 'Two colors, stands on a plinth',
    build: () => ({
      parts: [extrude('Plinth', 1, rect(64, 22), 0, 4), standUp(extrude('X', 2, xOutline(56), 0, 12), 4)],
      colors: ['#303241', brandAccent()],
    }),
  },
  {
    slug: 'calibration-cube',
    name: 'Calibration cube',
    note: '20 mm, one color',
    build: () => ({ parts: [extrude('Cube', 1, rect(20, 20), 0, 20)], colors: ['#8be9fd'] }),
  },
  {
    slug: 'wall-hook',
    name: 'Wall hook',
    note: 'Prints on its side',
    build: () => {
      const outer: Pt[] = [[-6, 30], [6, 30], [6, -2], ...arc(14, -2, 8, Math.PI, 2 * Math.PI, 10).slice(1), [22, 8], [28, 8], [28, -2], ...arc(14, -2, 14, 0, -Math.PI, 14).slice(1)]
      return { parts: [extrude('Hook', 1, outer.map(([x, y]) => [x - 8, y - 12] as Pt), 0, 12)], colors: ['#ffb86c'] }
    },
  },
  {
    slug: 'cable-clip',
    name: 'Cable clip',
    note: 'Snap fit, 6 mm cable',
    build: () => {
      const outer = arc(0, 0, 7, -Math.PI * 0.35, Math.PI * 1.35, 24)
      const inner = arc(0, 0, 4, Math.PI * 1.35, -Math.PI * 0.35, 20)
      return { parts: [extrude('Clip', 1, [...outer, ...inner], 0, 8), extrude('Foot', 1, rect(22, 3).map(([x, y]) => [x, y - 8.5] as Pt), 0, 8)], colors: ['#50fa7b', '#50fa7b'] }
    },
  },
  {
    slug: 'shelf-bracket',
    name: 'Shelf bracket',
    note: 'Strong settings suggested',
    build: () => ({
      parts: [extrude('Bracket', 1, ([[0, 0], [60, 0], [60, 6], [14, 6], [6, 14], [6, 60], [0, 60]] as Pt[]).map(([x, y]) => [x - 30, y - 30] as Pt), 0, 16)],
      colors: ['#ff79c6'],
    }),
  },
]

export const DEFAULT_MODEL = 'x-mark'

export function demoModel(slug: string): DemoModel | undefined {
  return DEMO_MODELS.find((m) => m.slug === slug)
}
