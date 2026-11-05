// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer height editor's handles: points whose dots would overlap on the graph draw as one handle. Drawing only;
// the points themselves (the plate's profile) are never merged or moved by this.

/** A point where the graph draws it, in the graph's own units. */
export interface ScreenPoint {
  x: number
  y: number
}

/** One handle on the graph: where it is drawn, and the points (by index, rising) it stands for. */
export interface Handle {
  x: number
  y: number
  members: number[]
}

/**
 * The handles for `pts` (the profile's points where the graph draws them, in the profile's order): a point joins the
 * first handle whose first point lies within `gap` of it, else starts its own. Joining by the first point, not the
 * last, keeps a row of close points from chaining into one long handle. The point at `alone` (the one being dragged)
 * always gets a handle of its own, so it never vanishes into another while it moves. A handle is drawn at its member
 * nearest the middle of its members, so it sits on the curve.
 */
export function profileHandles(pts: readonly ScreenPoint[], gap: number, alone: number | null = null): Handle[] {
  const groups: number[][] = []
  pts.forEach((p, i) => {
    const g = i === alone ? undefined : groups.find((m) => m[0] !== alone && Math.hypot(pts[m[0]!]!.x - p.x, pts[m[0]!]!.y - p.y) <= gap)
    if (g) g.push(i)
    else groups.push([i])
  })
  return groups.map((members) => {
    const cx = members.reduce((a, i) => a + pts[i]!.x, 0) / members.length
    const cy = members.reduce((a, i) => a + pts[i]!.y, 0) / members.length
    const at = nearestOf(pts, members, cx, cy)
    return { x: pts[at]!.x, y: pts[at]!.y, members }
  })
}

/** The member of `members` nearest (`x`, `y`): the point a press on a handle picks. Ties go to the lower point. */
export function nearestOf(pts: readonly ScreenPoint[], members: readonly number[], x: number, y: number): number {
  let best = members[0]!
  let d = Infinity
  for (const i of members) {
    const e = Math.hypot(pts[i]!.x - x, pts[i]!.y - y)
    if (e < d - 1e-9) {
      d = e
      best = i
    }
  }
  return best
}
