// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Flat faces of a triangle mesh: triangles joined across shared edges while they lie in one plane. Shared by the
// part tools here and the MCP's face tools.

export type V3 = [number, number, number]

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
const unit = (a: V3): V3 | undefined => {
  const l = len(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : undefined
}

export interface Tri {
  p: [V3, V3, V3]
  n: V3
  area: number
}

export function soupTriangles(pos: ArrayLike<number>): Tri[] {
  const out: Tri[] = []
  for (let t = 0; t + 9 <= pos.length; t += 9) {
    const at = (k: number): V3 => [pos[t + k] ?? 0, pos[t + k + 1] ?? 0, pos[t + k + 2] ?? 0]
    const p: [V3, V3, V3] = [at(0), at(3), at(6)]
    const c = cross(sub(p[1], p[0]), sub(p[2], p[0]))
    out.push({ p, n: unit(c) ?? [0, 0, 0], area: len(c) / 2 })
  }
  return out
}


/** An indexed part as triangles, in triangle order. */
export function partTriangles(m: { positions: ArrayLike<number>; indices: ArrayLike<number> }): Tri[] {
  const pos = new Array<number>(m.indices.length * 3)
  for (let k = 0; k < m.indices.length; k++) {
    const i = (m.indices[k] ?? 0) * 3
    pos[k * 3] = m.positions[i] ?? 0
    pos[k * 3 + 1] = m.positions[i + 1] ?? 0
    pos[k * 3 + 2] = m.positions[i + 2] ?? 0
  }
  return soupTriangles(pos)
}

export interface FaceSummary {
  triangle: number
  at: V3
  normal: V3
  facing?: string
  areaMm2: number
  center: V3
}

export const AXES: [string, V3][] = [['+x', [1, 0, 0]], ['-x', [-1, 0, 0]], ['+y', [0, 1, 0]], ['-y', [0, -1, 0]], ['+z (top)', [0, 0, 1]], ['-z (bottom)', [0, 0, -1]]]

/** Flat faces: triangles joined across shared edges while they lie in one plane. */
export function flatFaces(tris: Tri[]): FaceSummary[] {
  const key = (v: V3): string => v.map((c) => Math.round(c * 1e4)).join(',')
  const parent = tris.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] ?? i] ?? i
    return i
  }
  const edges = new Map<string, number>()
  tris.forEach((t, i) => {
    if (t.area <= 0) return
    for (let k = 0; k < 3; k++) {
      const a = key(t.p[k] as V3)
      const b = key(t.p[(k + 1) % 3] as V3)
      const e = a < b ? `${a}|${b}` : `${b}|${a}`
      const j = edges.get(e)
      if (j === undefined) {
        edges.set(e, i)
        continue
      }
      const o = tris[j]
      if (o && dot(o.n, t.n) > 0.99999 && Math.abs(dot(o.n, sub(t.p[0], o.p[0]))) < 1e-3) parent[find(i)] = find(j)
    }
  })
  const groups = new Map<number, number[]>()
  tris.forEach((t, i) => {
    if (t.area <= 0) return
    const r = find(i)
    groups.set(r, [...(groups.get(r) ?? []), i])
  })
  const round = (v: V3): V3 => v.map((c) => Math.round(c * 1000) / 1000) as V3
  const out: FaceSummary[] = []
  for (const list of groups.values()) {
    let area = 0
    const c: V3 = [0, 0, 0]
    let big = list[0] ?? 0
    for (const i of list) {
      const t = tris[i] as Tri
      area += t.area
      for (let k = 0; k < 3; k++) c[k] = (c[k] ?? 0) + ((t.p[0][k] ?? 0) + (t.p[1][k] ?? 0) + (t.p[2][k] ?? 0)) * (t.area / 3)
      if (t.area > (tris[big]?.area ?? 0)) big = i
    }
    const t = tris[big] as Tri
    const centroid: V3 = [0, 1, 2].map((k) => ((t.p[0][k] ?? 0) + (t.p[1][k] ?? 0) + (t.p[2][k] ?? 0)) / 3) as V3
    const facing = AXES.find(([, a]) => dot(a, t.n) > 0.9998)?.[0]
    out.push({ triangle: big, at: round(centroid), normal: round(t.n), ...(facing ? { facing } : {}), areaMm2: Math.round(area * 1000) / 1000, center: round(c.map((x) => x / area) as V3) })
  }
  return out.sort((a, b) => b.areaMm2 - a.areaMm2)
}

