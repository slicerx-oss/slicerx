// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What follows a section edit of a lofted body. Whatever stood on its top (a deckhouse, a cab, a cap) is re-seated on
// the new top at the step that made it, up or down, and if the body got narrower or lower under it the answer says
// plainly where it now hangs past the edge, sits into the body or stands clear of it: never a part left floating or
// buried without a word. An end leaned out far enough to need supports where it printed clean before is said too,
// and kept, since the person asked for it.
import { bakeMesh, type HistoryMesh, type Mat4 } from '@slicerx/cad-history'

type V2 = [number, number]

/** A part's mesh on the plate, at the design's transform. */
export const onPlate = (m: HistoryMesh, t: Mat4): HistoryMesh => bakeMesh(m, t)

/** The highest point of the mesh straight over (x, y), or null when none of it is there. */
export function surfaceAt(m: HistoryMesh, x: number, y: number): number | null {
  const p = m.positions
  const ix = m.indices
  let best: number | null = null
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = ix[t]! * 3
    const b = ix[t + 1]! * 3
    const c = ix[t + 2]! * 3
    const ax = p[a]!, ay = p[a + 1]!, bx = p[b]!, by = p[b + 1]!, cx = p[c]!, cy = p[c + 1]!
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(den) < 1e-12) continue
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den
    const w = 1 - u - v
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue
    const z = u * p[a + 2]! + v * p[b + 2]! + w * p[c + 2]!
    if (best === null || z > best) best = z
  }
  return best
}

/** How far point (x, y) is outside the body seen from above, toward `to` (mm; 0 when the body is under it). */
function hangAt(m: HistoryMesh, at: V2, to: V2): number {
  if (surfaceAt(m, at[0], at[1]) !== null) return 0
  const d = Math.hypot(to[0] - at[0], to[1] - at[1])
  for (let k = 1; k <= 60; k++) {
    const f = k / 60
    if (surfaceAt(m, at[0] + (to[0] - at[0]) * f, at[1] + (to[1] - at[1]) * f) !== null) return d * f
  }
  return d
}

/** Area (mm²) of the faces that look down steeper than 45 degrees, other than those lying on the bed: what needs supports. */
export function supportArea(m: HistoryMesh): number {
  const p = m.positions
  const ix = m.indices
  let area = 0
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = ix[t]! * 3
    const b = ix[t + 1]! * 3
    const c = ix[t + 2]! * 3
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-12) continue
    if (nz / len >= -Math.SQRT1_2) continue
    if (Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!) < 0.3) continue
    area += len / 2
  }
  return area
}

/** The box of a mesh on the plate. */
function box(m: HistoryMesh): { lo: [number, number, number]; hi: [number, number, number] } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < m.positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = m.positions[i + a]!
      if (v < lo[a]!) lo[a] = v
      if (v > hi[a]!) hi[a] = v
    }
  return { lo, hi }
}

/** A part standing on the body: its foot, the body's top under its middle, and how it met the body at its corners. */
export interface Standing {
  part: number
  middle: V2
  foot: number
  top: number
  corners: { at: V2; hang: number; rel: number | null }[]
}

/** Where a footprint's corners are read: a little in from its box, so a part on a rounded top still counts. */
function cornersOf(lo: number[], hi: number[]): V2[] {
  const ix = (hi[0]! - lo[0]!) * 0.05
  const iy = (hi[1]! - lo[1]!) * 0.05
  return [[lo[0]! + ix, lo[1]! + iy], [hi[0]! - ix, lo[1]! + iy], [hi[0]! - ix, hi[1]! - iy], [lo[0]! + ix, hi[1]! - iy]]
}

/** The parts standing on `body` (on the plate): foot within 1.5 mm of the body's top under the part's middle. */
export function standingOn(body: HistoryMesh, others: { part: number; mesh: HistoryMesh }[]): Standing[] {
  const out: Standing[] = []
  for (const { part, mesh } of others) {
    const b = box(mesh)
    const middle: V2 = [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2]
    const top = surfaceAt(body, middle[0], middle[1])
    if (top === null || b.lo[2] > top + 1.5 || b.lo[2] < top - 1.5) continue
    const corners = cornersOf(b.lo, b.hi).map((at) => {
      const s = surfaceAt(body, at[0], at[1])
      return { at, hang: hangAt(body, at, middle), rel: s === null ? null : b.lo[2] - s }
    })
    out.push({ part, middle, foot: b.lo[2], top, corners })
  }
  return out
}

/** How far to move a standing part up (or down) so it meets the new top as it met the old one; null when the body left its middle. */
export function seatShift(s: Standing, body: HistoryMesh): number | null {
  const top = surfaceAt(body, s.middle[0], s.middle[1])
  return top === null ? null : top - s.top
}

const r1 = (n: number): number => Math.round(n * 10) / 10

/** After the part was re-seated: what changed in how it meets the body, in words, or ''. */
export function seatWords(name: string, bodyName: string, s: Standing, body: HistoryMesh, footNow: number): string {
  const said: string[] = []
  let hang = 0
  let into = 0
  let clear = 0
  for (const c of s.corners) {
    hang = Math.max(hang, hangAt(body, c.at, s.middle) - c.hang)
    const now = surfaceAt(body, c.at[0], c.at[1])
    // only a corner that met the body before: one over a lower slope (a cap past a neck) says nothing of the seat
    if (now === null || c.rel === null || Math.abs(c.rel) > 1.5) continue
    const d = footNow - now - c.rel
    into = Math.max(into, -d)
    clear = Math.max(clear, d)
  }
  if (hang > 0.3) said.push(`${name} now hangs ${r1(hang)} mm past the edge of ${bodyName}`)
  if (into > 0.5) said.push(`${name} now sits ${r1(into)} mm into ${bodyName} at one corner`)
  if (clear > 0.5) said.push(`${name} now stands ${r1(clear)} mm clear of ${bodyName} at one corner`)
  return said.length ? `${said.join('; ')}: move or resize it, or edit the station under it` : ''
}
