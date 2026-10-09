// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { silhouettePath } from '../src/parts'

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
    const { d, size } = silhouettePath([tube(4, 8)])
    expect(size).toBeCloseTo(30, 3)
    expect(d.match(/M/g)?.length).toBeGreaterThan(20)
    expect(d).toContain('L')
  })

  it('keeps the path of a model of millions of triangles to a few hundred kilobytes, outline intact', () => {
    // 2.4 million triangles: drawn whole this was about 150 MB of path text.
    const { d, size } = silhouettePath([tube(1200, 1000)])
    expect(size).toBeCloseTo(30, 3)
    expect(d.length).toBeLessThan(400_000)
    expect(d).not.toContain('L')
    // Seen from the side the tube is a 20 by 30 rectangle in a 30 square: the middle row is filled across 20 of the
    // 30 mm and no further.
    const rows = d.split('M').filter(Boolean).map((r) => r.match(/[\d.]+/g)!.map(Number))
    const mid = rows.filter(([, y]) => y! > 14 && y! < 16)
    expect(mid.length).toBeGreaterThan(0)
    for (const [x0, , x1] of mid) {
      expect(x0).toBeGreaterThanOrEqual(4.5)
      expect(x1).toBeLessThanOrEqual(25.5)
    }
  })

  it('gives an empty path for no geometry', () => {
    expect(silhouettePath([{ positions: new Float32Array(), indices: new Uint32Array() }])).toEqual({ d: '', size: 1 })
  })
})
