// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the toolhead is part of the way through a move during Preview playback, and how much of that move's bead
// is laid down. The head runs along the move at its own pace rather than jumping from one move's end to the next:
// when the move starts away from where the last one ended, the first part of its time is the travel there (no
// bead yet); and where two moves meet, the head rounds the corner a little (at most CORNER_MM, and a quarter of
// either move), the way a real machine eases a change of direction instead of stopping dead.

/** One move as the preview buffer stores it: from (x0, y0) to (x1, y1) at height z, in bed millimetres. */
export interface HeadSeg {
  x0: number
  y0: number
  x1: number
  y1: number
  z: number
}

/** The head's point and the share of the move's bead drawn (0 while it is still travelling to the move). */
export interface HeadPoint {
  x: number
  y: number
  z: number
  reveal: number
}

/** Largest corner rounding, in millimetres. */
export const CORNER_MM = 1
/** Moves closer than this (mm) count as continuous: no travel between them. */
const JOIN_MM = 0.05
/** The travel to a move takes at most this share of the move's time, so the bead always gets the rest. */
const TRAVEL_SHARE_MAX = 0.5

const len = (s: HeadSeg) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
const along = (s: HeadSeg, d: number): [number, number] => {
  const l = len(s)
  const k = l > 1e-9 ? Math.min(1, Math.max(0, d / l)) : 1
  return [s.x0 + (s.x1 - s.x0) * k, s.y0 + (s.y1 - s.y0) * k]
}
const joined = (a: HeadSeg, b: HeadSeg) => Math.hypot(b.x0 - a.x1, b.y0 - a.y1) <= JOIN_MM && Math.abs(b.z - a.z) <= 1e-6
const bezier = (p0: [number, number], p1: [number, number], p2: [number, number], u: number): [number, number] => {
  const v = 1 - u
  return [v * v * p0[0] + 2 * v * u * p1[0] + u * u * p2[0], v * v * p0[1] + 2 * v * u * p1[1] + u * u * p2[1]]
}
/** The corner radius between two joined moves: the same from either side, so the head never jumps at the join. */
const radius = (a: HeadSeg, b: HeadSeg) => Math.min(CORNER_MM, 0.25 * len(a), 0.25 * len(b))

/**
 * The head `f` (0 to 1) of the way through move `i`'s time. `get` returns a move by index, or null past either end.
 * The point is continuous in time: at `f = 1` of one move it is where `f = 0` of a joined next move starts.
 */
export function headAt(get: (i: number) => HeadSeg | null, i: number, f: number): HeadPoint {
  const s = get(i)
  if (!s) return { x: 0, y: 0, z: 0, reveal: 0 }
  const prev = get(i - 1)
  const next = get(i + 1)
  const L = len(s)
  let t = Math.min(1, Math.max(0, f))
  // A travel into the move: the head crosses from the last move's end first, drawing nothing.
  if (prev && !joined(prev, s)) {
    const gap = Math.hypot(s.x0 - prev.x1, s.y0 - prev.y1) + Math.abs(s.z - prev.z)
    const share = Math.min(TRAVEL_SHARE_MAX, gap / (gap + Math.max(L, 1e-6)))
    if (t < share) {
      const u = share > 0 ? t / share : 1
      return { x: prev.x1 + (s.x0 - prev.x1) * u, y: prev.y1 + (s.y0 - prev.y1) * u, z: prev.z + (s.z - prev.z) * u, reveal: 0 }
    }
    t = share < 1 ? (t - share) / (1 - share) : 1
  }
  const d = t * L
  let p = along(s, d)
  // Ease the corner into the next joined move, and out of the joined move before.
  const rEnd = next && joined(s, next) ? radius(s, next) : 0
  const rStart = prev && joined(prev, s) ? radius(prev, s) : 0
  if (rEnd > 1e-6 && d > L - rEnd) {
    p = bezier(along(s, L - rEnd), [s.x1, s.y1], along(next!, rEnd), (d - (L - rEnd)) / (2 * rEnd))
  } else if (rStart > 1e-6 && d < rStart) {
    p = bezier(along(prev!, len(prev!) - rStart), [s.x0, s.y0], along(s, rStart), 0.5 + d / (2 * rStart))
  }
  return { x: p[0], y: p[1], z: s.z, reveal: t }
}
