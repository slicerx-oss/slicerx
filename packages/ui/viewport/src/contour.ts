// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a plane cuts a triangle mesh, as line segments. The height tool of the painter draws the cut at the bottom and top of
// its band on the model, as OrcaSlicer's height range cursor does. Pure math.

/**
 * Segments where the plane `n . p = d` crosses the triangles, as x0, y0, z0, x1, y1, z1 per segment. Triangles that lie in
 * the plane or only touch it at a corner give nothing.
 */
export function planeContour(positions: ArrayLike<number>, indices: ArrayLike<number>, n: [number, number, number], d: number): Float32Array {
  const out: number[] = []
  const tri = Math.floor(indices.length / 3)
  const dist = (i: number): number => n[0] * (positions[3 * i] ?? 0) + n[1] * (positions[3 * i + 1] ?? 0) + n[2] * (positions[3 * i + 2] ?? 0) - d
  const at = (i: number, j: number, di: number, dj: number): [number, number, number] => {
    const t = di / (di - dj)
    return [0, 1, 2].map((a) => (positions[3 * i + a] ?? 0) + t * ((positions[3 * j + a] ?? 0) - (positions[3 * i + a] ?? 0))) as [number, number, number]
  }
  for (let t = 0; t < tri; t++) {
    const v = [indices[3 * t] ?? 0, indices[3 * t + 1] ?? 0, indices[3 * t + 2] ?? 0]
    const ds = v.map(dist)
    const pts: [number, number, number][] = []
    for (let e = 0; e < 3; e++) {
      const a = e
      const b = (e + 1) % 3
      const da = ds[a] as number
      const db = ds[b] as number
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) pts.push(at(v[a] as number, v[b] as number, da, db))
      else if (da === 0 && db !== 0 && ds[(e + 2) % 3] !== 0 && Math.sign(db) !== Math.sign(ds[(e + 2) % 3] as number)) pts.push(at(v[a] as number, v[b] as number, da, db))
    }
    if (pts.length === 2) out.push(...(pts[0] as number[]), ...(pts[1] as number[]))
  }
  return new Float32Array(out)
}
