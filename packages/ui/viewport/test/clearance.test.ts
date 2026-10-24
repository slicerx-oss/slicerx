// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { ClearanceZones, clearanceConflicts, convexOverlap } from '../src/clearance'

type Pt = [number, number]
const rect = (x: number, y: number, w: number, d: number): Pt[] => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]]
const GANTRY = { rodMm: 34, reachMm: 20 }

describe('clearance zones', () => {
  it('tells overlapping convex zones from ones that only touch or stand apart', () => {
    expect(convexOverlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(true)
    expect(convexOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(false)
    expect(convexOverlap(rect(0, 0, 10, 10), rect(30, 0, 10, 10))).toBe(false)
    // a diamond whose box overlaps the square's, though the shapes do not
    expect(convexOverlap(rect(0, 0, 10, 10), [[13, 8], [18, 13], [13, 18], [8, 13]])).toBe(false)
    expect(convexOverlap([], rect(0, 0, 1, 1))).toBe(false)
  })

  it('marks both objects of an overlap, and a tall one whose lane a later object meets', () => {
    const z = (id: string, x: number, y: number, top: number) => ({ id, zone: rect(x - 34, y - 34, 88, 88), hull: rect(x, y, 20, 20), topMm: top })
    const { hot, lanes } = clearanceConflicts([z('tall', 0, 100, 45), z('b', 67, 100, 10), z('c', 200, 230, 10)], GANTRY)
    expect([...hot].sort()).toEqual(['b', 'tall'])
    expect(lanes.get('tall')).toEqual({ lo: 80, hi: 140, hit: true })
    expect(lanes.has('b')).toBe(false)
    // printed last, its lane is drawn but nothing later meets it
    expect(clearanceConflicts([z('b', 150, 100, 10), z('tall', 0, 100, 45)], GANTRY).lanes.get('tall')?.hit).toBe(false)
  })

  it('moves a zone with its object and clears the red once it is dragged apart', () => {
    const c = new ClearanceZones()
    const at = (x: number) => new Matrix4().makeTranslation(x, 0, 0)
    const zone = (id: string, x: number) => ({ id, transform: at(x).toArray(), zone: rect(x - 34, 66, 88, 88), hull: rect(x, 100, 20, 20), topMm: 10 })
    c.set({ zones: [zone('a', 0), zone('b', 67)], gantry: { ...GANTRY, widthMm: 256 }, selected: [] })
    const where = new Map([['a', at(0)], ['b', at(67)]])
    c.follow((id) => where.get(id))
    expect([...c.conflicts].sort()).toEqual(['a', 'b'])
    where.set('b', at(120))
    c.follow((id) => where.get(id))
    expect(c.conflicts.size).toBe(0)
    c.set(null)
    expect(c.group.visible).toBe(false)
    c.dispose()
  })
})

describe('a close call', () => {
  it('leaves the overlapping zones of a pair heimdall slices neutral, and others red', () => {
    const z = (id: string, x: number) => ({ id, zone: rect(x - 34, 66, 88, 88), hull: rect(x, 100, 20, 20), topMm: 10 })
    const zones = [z('a', 0), z('b', 67), z('c', 134)]
    const gantry = { rodMm: 34, reachMm: 20 }
    expect([...clearanceConflicts(zones, gantry).hot].sort()).toEqual(['a', 'b', 'c'])
    expect([...clearanceConflicts(zones, gantry, [['b', 'a']]).hot].sort()).toEqual(['b', 'c'])
    expect([...clearanceConflicts(zones, gantry, [['a', 'b'], ['b', 'c']]).hot]).toEqual([])
  })
})

