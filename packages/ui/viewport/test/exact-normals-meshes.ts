// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Test meshes with their analytic corner normals (nine numbers per triangle, in index order), and a digest of creased
// arrays, for exact-normals.test.ts. No imports, so the digests of the creasing before exact normals can be made from
// the same shapes.

export interface TestMesh {
  positions: Float32Array
  indices: Uint32Array
  /** The surface's own normal at each triangle corner, nine numbers per triangle. */
  corners: Float64Array
}

/** A UV sphere of radius `r` about the origin, one vertex at each pole, wound outward. */
export function sphere(r: number, seg: number, rings: number, jitter = 0): TestMesh {
  const pts: number[] = []
  // a fixed generator, so a jittered sphere is the same everywhere
  let seed = 12345
  const rand = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 4294967296 - 0.5
  }
  const put = (x: number, y: number, z: number): void => {
    pts.push(x + jitter * rand(), y + jitter * rand(), z + jitter * rand())
  }
  put(0, 0, r)
  for (let i = 1; i < rings; i++) {
    const th = (Math.PI * i) / rings
    for (let j = 0; j < seg; j++) {
      const ph = (2 * Math.PI * j) / seg
      put(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th))
    }
  }
  put(0, 0, -r)
  const last = pts.length / 3 - 1
  const v = (i: number, j: number): number => (i === 0 ? 0 : i === rings ? last : 1 + (i - 1) * seg + (j % seg))
  const ix: number[] = []
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1)
      if (i > 0) ix.push(a, c, d)
      if (i < rings - 1) ix.push(a, b, c)
    }
  }
  const positions = new Float32Array(pts)
  const indices = new Uint32Array(ix)
  const corners = new Float64Array(indices.length * 3)
  for (let k = 0; k < indices.length; k++) {
    const p = indices[k]! * 3
    const x = positions[p]!, y = positions[p + 1]!, z = positions[p + 2]!
    const l = Math.hypot(x, y, z)
    corners[3 * k] = x / l
    corners[3 * k + 1] = y / l
    corners[3 * k + 2] = z / l
  }
  return { positions, indices, corners }
}

/** A closed cylinder of radius `r` and height `h` standing on the origin, caps sharing the rim vertices, wound outward. */
export function cylinder(r: number, h: number, seg: number): TestMesh {
  const pts: number[] = []
  for (const z of [0, h]) for (let j = 0; j < seg; j++) {
    const ph = (2 * Math.PI * j) / seg
    pts.push(r * Math.cos(ph), r * Math.sin(ph), z)
  }
  pts.push(0, 0, 0, 0, 0, h)
  const bc = 2 * seg, tc = 2 * seg + 1
  const ix: number[] = []
  // 0 side, 1 top, -1 bottom, per triangle
  const kind: number[] = []
  for (let j = 0; j < seg; j++) {
    const b0 = j, b1 = (j + 1) % seg, t0 = seg + j, t1 = seg + ((j + 1) % seg)
    ix.push(b0, b1, t1, b0, t1, t0, tc, t0, t1, bc, b1, b0)
    kind.push(0, 0, 1, -1)
  }
  const positions = new Float32Array(pts)
  const indices = new Uint32Array(ix)
  const corners = new Float64Array(indices.length * 3)
  for (let k = 0; k < indices.length; k++) {
    const p = indices[k]! * 3
    const s = kind[(k / 3) | 0]!
    if (s !== 0) {
      corners[3 * k + 2] = s
      continue
    }
    const x = positions[p]!, y = positions[p + 1]!
    const l = Math.hypot(x, y)
    corners[3 * k] = x / l
    corners[3 * k + 1] = y / l
  }
  return { positions, indices, corners }
}

/** A box as triangle soup: three vertices per triangle, nothing shared, the way an unindexed file comes. */
export function boxSoup(sx: number, sy: number, sz: number): { positions: Float32Array; indices: Uint32Array } {
  const c = [
    [0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0],
    [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz],
  ]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const pts: number[] = []
  for (const [a, b, d, e] of quads) for (const v of [a, b, d, a, d, e]) pts.push(...c[v!]!)
  const positions = new Float32Array(pts)
  return { positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) }
}

/** FNV-1a over the bytes of the arrays, with their lengths: equal digests mean the very same numbers. */
export function digest(...arrays: ArrayBufferView[]): string {
  let h = 0x811c9dc5
  const lengths: number[] = []
  for (const a of arrays) {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    lengths.push(b.length)
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193)
  }
  return `${lengths.join('/')}:${(h >>> 0).toString(16).padStart(8, '0')}`
}
