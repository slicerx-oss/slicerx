// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { silhouettePath } from '../src/parts'
import { contours, simplifyLoop, tracedPath } from '../src/silhouette-trace'

/** A tube of `rings` by `around` quads, two triangles each: 2 * rings * around triangles. */
function tube(rings: number, around: number): { positions: Float32Array; indices: Uint32Array } {
  const p: number[] = []
  const t: number[] = []
  for (let r = 0; r <= rings; r++) for (let a = 0; a < around; a++) p.push(10 * Math.cos((a / around) * 2 * Math.PI), 10 * Math.sin((a / around) * 2 * Math.PI), (r / rings) * 30)
  const at = (r: number, a: number) => r * around + (a % around)
  for (let r = 0; r < rings; r++) for (let a = 0; a < around; a++) t.push(at(r, a), at(r, a + 1), at(r + 1, a + 1), at(r, a), at(r + 1, a + 1), at(r + 1, a))
  return { positions: new Float32Array(p), indices: new Uint32Array(t) }
}

describe('the object list silhouette', () => {
  it('draws a small model triangle by triangle', () => {
    const { d, size } = silhouettePath([tube(4, 8)], null)!
    expect(size).toBeCloseTo(30, 3)
    expect(d.match(/M/g)?.length).toBeGreaterThan(20)
    expect(d).toContain('L')
  })

  it('keeps the exact outline of a model of tens of thousands of triangles', () => {
    // 40,000 triangles: still drawn triangle by triangle, filled nonzero.
    const { d, evenOdd } = silhouettePath([tube(100, 200)], null)!
    expect(evenOdd).toBeUndefined()
    expect(d.match(/M/g)?.length).toBeGreaterThan(30_000)
  })

  it('keeps the path of a model of millions of triangles to a few kilobytes, outline intact', () => {
    // 2.4 million triangles: drawn whole this was about 150 MB of path text. Without the tracer (it loads on demand)
    // there is no path yet.
    expect(silhouettePath([tube(1200, 1000)], null)).toBeNull()
    const { d, size, evenOdd } = silhouettePath([tube(1200, 1000)], tracedPath)!
    expect(size).toBeCloseTo(30, 3)
    expect(evenOdd).toBe(true)
    expect(d.length).toBeLessThan(4000)
    // Seen from the side the tube is a 20 by 30 rectangle centered in a 30 square: one contour of a few points, all
    // on that rectangle's edge to within a cell.
    expect(d.match(/M/g)?.length).toBe(1)
    const pts = d.match(/-?[\d.]+ -?[\d.]+/g)!.map((p) => p.split(' ').map(Number) as [number, number])
    expect(pts.length).toBeLessThan(40)
    const cell = 30 / 96
    for (const [x, y] of pts) {
      const edge = Math.min(Math.abs(x - 5), Math.abs(x - 25), Math.abs(y), Math.abs(y - 30))
      expect(edge).toBeLessThan(1.5 * cell)
      expect(x).toBeGreaterThan(5 - 1.5 * cell)
      expect(x).toBeLessThan(25 + 1.5 * cell)
    }
  })

  it('traces a slanted edge as a straight line, not as stairs', () => {
    // A disc of radius 30 samples in a 100 square field: its contour after simplifying stays on the circle and needs
    // a few dozen points, where the stairs of its cells would need hundreds.
    const W = 100
    const field = new Float32Array(W * W)
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) field[y * W + x] = Math.max(0, Math.min(1, 30.5 - Math.hypot(x - 50, y - 50)))
    const loops = contours(field, W, 0.5)
    expect(loops.length).toBe(1)
    const loop = simplifyLoop(loops[0]!, 0.5)
    expect(loop.length / 2).toBeGreaterThan(8)
    expect(loop.length / 2).toBeLessThan(60)
    for (let i = 0; i < loop.length; i += 2) expect(Math.abs(Math.hypot(loop[i]! - 50, loop[i + 1]! - 50) - 30)).toBeLessThan(0.6)
  })

  it('keeps a hole as a contour of its own', () => {
    const W = 40
    const field = new Float32Array(W * W)
    for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) field[y * W + x] = x > 15 && x < 25 && y > 15 && y < 25 ? 0 : 1
    expect(contours(field, W, 0.5).length).toBe(2)
  })

  it('gives an empty path for no geometry', () => {
    expect(silhouettePath([{ positions: new Float32Array(), indices: new Uint32Array() }], null)).toEqual({ d: '', size: 1 })
  })
})
