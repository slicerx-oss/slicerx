// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import {
  autoDetail, cylinderRegion, decodeTree, encodeTree, fillByAngle, fillConnected, isLeaf, leavesOf, paintDab, paintTexts, paintTriangle, readPaintTexts, slabRegion, sphereRegion,
  gapFill, paintLeafAt, paintPatch, replaceEverywhere, stateAt, trianglePoints, withPointFilter, type PaintMap, type PaintNode, type Tri,
} from '../src/paint'

const TRI: Tri = [[0, 0, 0], [20, 0, 0], [20, 20, 0]]
const area = (t: Tri): number => Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2
const painted = (n: PaintNode, state: number): number => leavesOf(TRI, n).filter((l) => l.state === state).reduce((a, l) => a + area(l.v), 0)

describe('paint text', () => {
  it.each(['4', '8', '0C', '1C', '2C', '481', '485', '1C0C843', '1C0C811'])('round trips the text %s as sx-core reads it', (t) => {
    const n = decodeTree(t)
    expect(n).not.toBeNull()
    expect(encodeTree(n as PaintNode)).toBe(t)
  })

  it('reads the extended and plain states', () => {
    expect(decodeTree('4')).toEqual({ state: 1 })
    expect(decodeTree('8')).toEqual({ state: 2 })
    expect(decodeTree('0C')).toEqual({ state: 3 })
    expect(decodeTree('1C')).toEqual({ state: 4 })
    expect(decodeTree('2C')).toEqual({ state: 5 })
  })

  it('refuses text that is not a tree, and writes nothing for an unpainted triangle', () => {
    expect(decodeTree('zz')).toBeNull()
    expect(decodeTree('')).toBeNull()
    expect(decodeTree('1')).toBeNull()
    expect(encodeTree({ state: 0 })).toBeNull()
  })

  it('lays children out the way sx-core reads them', () => {
    const half = leavesOf(TRI, decodeTree('481') as PaintNode)
    const two = half.find((l) => l.state === 2) as { v: Tri }
    expect(two.v.some((p) => p[0] === 20 && p[1] === 10)).toBe(true)
    expect(two.v.some((p) => p[0] === 20 && p[1] === 20)).toBe(true)
    expect(area(two.v)).toBeCloseTo(100)
    const moved = leavesOf(TRI, decodeTree('485') as PaintNode).find((l) => l.state === 2) as { v: Tri }
    expect(moved.v.some((p) => p[0] === 10 && p[1] === 10)).toBe(true)
    const four = leavesOf(TRI, decodeTree('1C0C843') as PaintNode)
    expect(four).toHaveLength(4)
    expect(four.reduce((a, l) => a + area(l.v), 0)).toBeCloseTo(200)
    expect(area((four.find((l) => l.state === 1) as { v: Tri }).v)).toBeCloseTo(50)
    const nested = leavesOf(TRI, decodeTree('1C0C811') as PaintNode)
    expect(nested).toHaveLength(3)
    expect(nested.reduce((a, l) => a + area(l.v), 0)).toBeCloseTo(200)
  })

  it('round trips random nested trees', () => {
    let s = 7
    const rnd = (): number => {
      s = (s * 16807) % 2147483647
      return s / 2147483647
    }
    const make = (depth: number): PaintNode => {
      if (depth >= 4 || rnd() < 0.35) return { state: Math.floor(rnd() * 7) }
      const splits = (1 + Math.floor(rnd() * 3)) as 1 | 2 | 3
      return { splits, special: Math.floor(rnd() * 3) as 0 | 1 | 2, kids: Array.from({ length: splits + 1 }, () => make(depth + 1)) }
    }
    for (let i = 0; i < 200; i++) {
      const n = make(0)
      const text = encodeTree(n)
      if (text === null) expect(isLeaf(n) && n.state === 0).toBe(true)
      else expect(decodeTree(text)).toEqual(n)
    }
  })

  it('writes texts per painted triangle and reads them back, listing bad ones', () => {
    const map: PaintMap = new Map([[3, { state: 2 }], [7, { state: 0 }]])
    const texts = paintTexts(map)
    expect(texts).toEqual({ 3: '8' })
    const back = readPaintTexts({ ...texts, 9: 'qq', 10: '0' })
    expect([...back.map.keys()]).toEqual([3])
    expect(back.bad).toEqual([9])
  })
})

describe('brush on one triangle', () => {
  const opts = { minEdge: 1 }

  it('paints a triangle the brush covers as one leaf, no split', () => {
    const n = paintTriangle(TRI, { state: 0 }, sphereRegion([14, 6, 0], 40), 2, opts)
    expect(n).toEqual({ state: 2 })
  })

  it('leaves a triangle the brush misses alone', () => {
    const before: PaintNode = { state: 0 }
    expect(paintTriangle(TRI, before, sphereRegion([100, 100, 0], 5), 2, opts)).toBe(before)
  })

  it('splits where the brush edge cuts and keeps the areas whole', () => {
    const n = paintTriangle(TRI, { state: 0 }, sphereRegion([20, 10, 0], 5), 1, { minEdge: 0.5 })
    expect(isLeaf(n)).toBe(false)
    expect(painted(n, 0) + painted(n, 1)).toBeCloseTo(200)
    // The disc of radius 5 at the middle of the long edge: about half of it lies in the triangle.
    expect(painted(n, 1)).toBeGreaterThan(30)
    expect(painted(n, 1)).toBeLessThan(45)
    expect(stateAt(TRI, n, [19, 10, 0])).toBe(1)
    expect(stateAt(TRI, n, [5, 2, 0])).toBe(0)
    const back = decodeTree(encodeTree(n) as string)
    expect(back).toEqual(n)
  })

  it('finer minEdge follows the edge more closely', () => {
    const coarse = paintTriangle(TRI, { state: 0 }, sphereRegion([20, 10, 0], 5), 1, { minEdge: 4 })
    const fine = paintTriangle(TRI, { state: 0 }, sphereRegion([20, 10, 0], 5), 1, { minEdge: 0.4 })
    const exact = (Math.PI * 25) / 2
    expect(Math.abs(painted(fine, 1) - exact)).toBeLessThan(Math.abs(painted(coarse, 1) - exact))
  })

  it('erases back to an unpainted triangle and merges the pieces', () => {
    const painted1 = paintTriangle(TRI, { state: 0 }, sphereRegion([20, 10, 0], 5), 1, { minEdge: 0.5 })
    const erased = paintTriangle(TRI, painted1, sphereRegion([10, 10, 0], 100), 0, opts)
    expect(erased).toEqual({ state: 0 })
  })

  it('never splits below the nesting limit', () => {
    const n = paintTriangle(TRI, { state: 0 }, sphereRegion([20, 10, 0], 5), 1, { minEdge: 1e-6 })
    const depth = (x: PaintNode): number => (isLeaf(x) ? 0 : 1 + Math.max(...x.kids.map(depth)))
    expect(depth(n)).toBeLessThanOrEqual(12)
    expect(decodeTree(encodeTree(n) as string)).not.toBeNull()
  })

  it('paints by the center of the piece when splitting is off', () => {
    const n = paintTriangle(TRI, { state: 0 }, sphereRegion([13, 6, 0], 3), 1, { minEdge: 1, noSplit: true })
    expect(n).toEqual({ state: 1 })
  })

  it('height range paints a slab of a slanted triangle', () => {
    const t: Tri = [[0, 0, 0], [10, 0, 0], [0, 0, 10]]
    const n = paintTriangle(t, { state: 0 }, slabRegion([0, 0, 1], 4, 6), 3, { minEdge: 0.3 })
    const a = leavesOf(t, n).filter((l) => l.state === 3)
    const z = a.flatMap((l) => l.v.map((p) => p[2]))
    expect(Math.min(...z)).toBeGreaterThan(3.3)
    expect(Math.max(...z)).toBeLessThan(6.7)
  })
})

// Unit cube, outward wound.
const P = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])
const I = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
const mesh = { positions: P, indices: I }

describe('painting a mesh', () => {
  it('a sphere dab changes only nearby triangles and reports them', () => {
    const map: PaintMap = new Map()
    const changed = paintDab(mesh, map, [[-0.2, -0.2, -0.2], [0.2, 0.2, 0.2]], sphereRegion([0, 0, 0], 0.2), 1, { minEdge: 0.05 })
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.length).toBeLessThan(12)
    expect([...map.keys()].sort()).toEqual([...changed].sort())
    const far = paintDab(mesh, map, [[0.95, 0.95, 0.95], [1.05, 1.05, 1.05]], sphereRegion([1, 1, 1], 0.05), 2, { minEdge: 0.02 })
    expect(far.length).toBeGreaterThan(0)
    expect(far.some((t) => changed.includes(t))).toBe(false)
  })

  it('a circle brush along the view only paints the faces that look at the viewer', () => {
    const map: PaintMap = new Map()
    // Looking down -z from above: only the top face (z = 1) faces the viewer.
    const changed = paintDab(mesh, map, [[-1, -1, -1], [2, 2, 2]], cylinderRegion([0.5, 0.5, 5], [0, 0, -1], 5, true), 1, { minEdge: 2 })
    for (const t of changed) {
      const tri = [0, 1, 2].map((k) => I[3 * t + k] as number).map((i) => P[3 * i + 2])
      expect(tri.every((z) => z === 1)).toBe(true)
    }
    expect(changed).toHaveLength(2)
  })

  it('bucket fill floods the connected unpainted surface and stops at paint', () => {
    const map: PaintMap = new Map([[4, { state: 1 }], [5, { state: 1 }]])
    const changed = fillConnected(mesh, map, 0, [0.2, 0.2, 0], 3)
    expect(changed).toHaveLength(10)
    expect(map.get(4)).toEqual({ state: 1 })
    expect(map.get(0)).toEqual({ state: 3 })
    expect(fillConnected(mesh, map, 0, [0.2, 0.2, 0], 3)).toEqual([])
  })

  it('smart fill follows the angle: a tight angle keeps to one face, a wide one wraps the cube', () => {
    const tight: PaintMap = new Map()
    expect(fillByAngle(mesh, tight, 0, 2, 10).sort()).toEqual([0, 1])
    const wide: PaintMap = new Map()
    expect(fillByAngle(mesh, wide, 0, 2, 100)).toHaveLength(12)
  })

  it('erase by fill clears', () => {
    const map: PaintMap = new Map()
    fillByAngle(mesh, map, 0, 2, 100)
    fillByAngle(mesh, map, 0, 0, 100)
    expect(map.size).toBe(0)
  })
})

describe('Orca style patch brush', () => {
  const big = sphereRegion([0.5, 0.5, 0.5], 10)
  const opts = { minEdge: 5 }

  it('spreads only over connected surface facing the viewer', () => {
    const map: PaintMap = new Map()
    // Looking straight down the z axis at the top face (triangles 2 and 3 of the cube): the sides are edge-on.
    const changed = paintPatch(mesh, map, 2, big, 1, opts, [0, 0, -1])
    const tops = changed.filter((t) => [0, 1, 2].every((k) => P[3 * (I[3 * t + k] as number) + 2] === 1))
    expect(changed.sort()).toEqual(tops.sort())
    expect(changed).toHaveLength(2)
  })

  it('takes every face that looks toward the viewer, and none that looks away', () => {
    const map: PaintMap = new Map()
    // From the +x, +y, +z corner toward the origin: the three faces at the corner face the viewer.
    const changed = paintPatch(mesh, map, 2, big, 1, opts, [-1, -1, -1])
    expect(changed).toHaveLength(6)
    for (const t of changed) {
      const n = [0, 1, 2].map((k) => I[3 * t + k] as number).map((i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]])
      const onFace = [0, 1, 2].some((a) => n.every((p) => p[a] === 1))
      expect(onFace).toBe(true)
    }
  })

  it('does not reach a surface that is not connected to the start', () => {
    // Two separate triangles facing the viewer: only the one under the pointer is painted.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0, 0, 6, 0, 0, 5, 1, 0])
    const idx = new Uint32Array([0, 1, 2, 3, 4, 5])
    const map: PaintMap = new Map()
    const changed = paintPatch({ positions: pos, indices: idx }, map, 0, sphereRegion([3, 0, 0], 50), 1, opts, [0, 0, -1])
    expect(changed).toEqual([0])
  })

  it('starts on the pointer triangle even when it faces away', () => {
    const map: PaintMap = new Map()
    expect(paintPatch(mesh, map, 0, big, 1, opts, [0, 0, -1]).includes(0)).toBe(true)
  })

  it('uses the detail rule min(radius / 5, 0.05)', () => {
    expect(autoDetail(1)).toBeCloseTo(0.05)
    expect(autoDetail(0.2)).toBeCloseTo(0.04)
    expect(autoDetail(8)).toBeCloseTo(0.05)
  })

  it('the pointer tool repaints only the piece under the point', () => {
    const split = decodeTree('481') as PaintNode
    const out = paintLeafAt(TRI, split, [19, 15, 0], 3)
    expect(stateAt(TRI, out, [19, 15, 0])).toBe(3)
    expect(stateAt(TRI, out, [5, 1, 0])).toBe(1)
  })

  it('bucket fill honors the angle between neighbors', () => {
    const map: PaintMap = new Map()
    expect(fillConnected(mesh, map, 0, [0.2, 0.2, 0], 3, 10)).toHaveLength(2)
    const all: PaintMap = new Map()
    expect(fillConnected(mesh, all, 0, [0.2, 0.2, 0], 3, -1)).toHaveLength(12)
  })
})

describe('Orca features', () => {
  it('the overhang gate refuses triangles and nothing spreads through them', () => {
    const map: PaintMap = new Map()
    const big = sphereRegion([0.5, 0.5, 0.5], 10)
    // Only the top face passes: the start is a top triangle and the sides are refused.
    const top = (t: number): boolean => [0, 1, 2].every((k) => P[3 * (I[3 * t + k] as number) + 2] === 1)
    const changed = paintPatch(mesh, map, 2, big, 1, { minEdge: 5 }, [-1, -1, -1], undefined, top)
    expect(changed.sort()).toEqual([2, 3])
    const smart: PaintMap = new Map()
    expect(fillByAngle(mesh, smart, 2, 1, 100, undefined, top).sort()).toEqual([2, 3])
  })

  it('a point filter (the clipping plane) skips what it refuses and splits at its edge', () => {
    const tri: Tri = [[0, 0, 0], [10, 0, 0], [0, 10, 0]]
    const keep = withPointFilter(sphereRegion([3, 3, 0], 100), (p) => p[0] < 5)
    expect(keep.classify(tri)).toBe('partial')
    expect(withPointFilter(sphereRegion([3, 3, 0], 100), () => false).classify(tri)).toBe('outside')
    const n = paintTriangle(tri, { state: 0 }, keep, 1, { minEdge: 0.5 })
    for (const l of leavesOf(tri, n).filter((l) => l.state === 1)) expect((l.v[0][0] + l.v[1][0] + l.v[2][0]) / 3).toBeLessThan(5.6)
  })

  it('color replace changes every leaf of a state, honoring the filter', () => {
    const map: PaintMap = new Map([[0, { state: 2 }], [5, { state: 2 }], [7, { state: 1 }]])
    const changed = replaceEverywhere(mesh, map, 2, 3, (t) => t !== 5)
    expect(changed).toEqual([0])
    expect(map.get(0)).toEqual({ state: 3 })
    expect(map.get(5)).toEqual({ state: 2 })
    expect(map.get(7)).toEqual({ state: 1 })
  })

  it('gap fill merges a small patch into its lowest neighbor state and leaves big ones', () => {
    // A cube face painted 1 with one triangle of a neighboring face painted 2: the single painted triangle is a gap.
    const map: PaintMap = new Map([[4, { state: 2 }]])
    expect(gapFill(mesh, map, 0)).toEqual([])
    const changed = gapFill(mesh, map, 5)
    expect(changed).toEqual([4])
    expect(map.size).toBe(0)
    const keep: PaintMap = new Map([[0, { state: 2 }], [1, { state: 2 }]])
    // The bottom face (two triangles, area 1) is bigger than the threshold 0.4, so it stays.
    expect(gapFill(mesh, keep, 0.4)).toEqual([])
    expect(keep.size).toBe(2)
  })

  it('a fragment inside a split triangle goes to the neighbor with the lowest state', () => {
    // Triangle 0 of the cube split in two halves (0.25 each) painted 2 and 1, surrounded by unpainted surface.
    const map: PaintMap = new Map([[0, decodeTree('481') as PaintNode]])
    const changed = gapFill(mesh, map, 0.3)
    expect(changed).toEqual([0])
    // Both halves are fragments; unpainted (0) is the lowest state they touch, so the paint is gone.
    expect(map.size).toBe(0)
  })
})
