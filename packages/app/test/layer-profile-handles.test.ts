// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer height editor's handles: points whose dots would overlap on the graph draw as one handle, a press takes the
// point nearest the pointer, and the plate's points themselves never change.
import { describe, expect, it } from 'vitest'
import { profileFromTops, type ProfilePoint } from '../src/plate/layer-profile'
import { nearestOf, profileHandles, type ScreenPoint } from '../src/workspaces/prepare/layer-profile-handles'

// The editor's desktop graph: 0.08 to 0.28 mm across 264 units, 0 to 60 mm up 316, dots of radius 6.
const GAP = 12
const draw = (pts: readonly ProfilePoint[]): ScreenPoint[] => pts.map(([z, h]) => ({ x: 44 + ((h - 0.08) / 0.2) * 264, y: 328 - (z / 60) * 316 }))
const everyOnce = (n: number, members: number[][]) => expect(members.flat().sort((a, b) => a - b)).toEqual([...Array(n).keys()])

describe("the editor's handles", () => {
  it("draw a sleipnir plan's close points as single handles, and leave the points as they are", () => {
    // A plan as sleipnir makes one on a 60 mm part: 0.2 mm layers that thin by 0.005 mm for a millimeter at a time near
    // the bottom and the top, where the surface turns. Each turn keeps two points a fraction of a millimeter apart.
    const tops = [0.2]
    while (tops[tops.length - 1]! < 60 - 1e-9) {
      const z = tops[tops.length - 1]!
      const turn = (z < 6 || z > 54) && Math.floor(z) % 2 === 1
      tops.push(Number(Math.min(60, z + (turn ? 0.195 : 0.2)).toFixed(4)))
    }
    const points = profileFromTops(tops)
    const kept = structuredClone(points)
    const handles = profileHandles(draw(points), GAP)
    expect(handles.length).toBeLessThan(points.length)
    expect(handles.some((h) => h.members.length > 1)).toBe(true)
    everyOnce(points.length, handles.map((h) => h.members))
    expect(points).toEqual(kept)
  })

  it('keep points a dot or more apart as handles of their own', () => {
    const pts = draw([[0.2, 0.12], [30, 0.12], [60, 0.24]])
    expect(profileHandles(pts, GAP).map((h) => h.members)).toEqual([[0], [1], [2]])
  })

  it('merge a pair under a dot apart, drawn on one of its points', () => {
    const pts: ScreenPoint[] = [{ x: 100, y: 300 }, { x: 104, y: 297 }, { x: 200, y: 100 }]
    const handles = profileHandles(pts, GAP)
    expect(handles.map((h) => h.members)).toEqual([[0, 1], [2]])
    expect([pts[0], pts[1]]).toContainEqual({ x: handles[0]!.x, y: handles[0]!.y })
  })

  it('do not chain a row of close points into one long handle', () => {
    const row: ScreenPoint[] = Array.from({ length: 10 }, (_, i) => ({ x: 100 + i * 8, y: 200 }))
    const handles = profileHandles(row, GAP)
    everyOnce(10, handles.map((h) => h.members))
    for (const h of handles) for (const i of h.members) expect(Math.abs(row[i]!.x - row[h.members[0]!]!.x)).toBeLessThanOrEqual(GAP)
    expect(handles.length).toBeGreaterThan(1)
  })

  it('give the point being dragged a handle of its own', () => {
    const pts: ScreenPoint[] = [{ x: 100, y: 300 }, { x: 104, y: 297 }, { x: 106, y: 299 }]
    expect(profileHandles(pts, GAP, 1).map((h) => h.members)).toEqual([[0, 2], [1]])
    expect(profileHandles(pts, GAP, 0).map((h) => h.members)).toEqual([[0], [1, 2]])
  })

  it('take the point nearest the pointer on a press, the lower one on a tie', () => {
    const pts: ScreenPoint[] = [{ x: 100, y: 300 }, { x: 104, y: 300 }, { x: 110, y: 300 }]
    expect(nearestOf(pts, [0, 1, 2], 103, 300)).toBe(1)
    expect(nearestOf(pts, [0, 1, 2], 109, 301)).toBe(2)
    expect(nearestOf(pts, [0, 1], 102, 300)).toBe(0)
  })
})
