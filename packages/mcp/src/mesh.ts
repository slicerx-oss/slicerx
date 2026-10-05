// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Minimal STL reading and writing for the MCP host: triangle soup in, stats
// and a combined plate out. The real loaders live in sx-core.

export interface MeshStats {
  triangles: number
  /** Axis-aligned size in mm, Z up. */
  bboxMm: [number, number, number]
  /** Lowest corner of the bounding box, mm. */
  minMm: [number, number, number]
  areaMm2: number
  volumeMm3: number
}

/** Non-indexed triangle positions, 9 floats per triangle. */
export function readStlPositions(buf: Buffer): Float32Array {
  if (buf.length >= 84) {
    const count = buf.readUInt32LE(80)
    if (84 + count * 50 === buf.length) {
      const out = new Float32Array(count * 9)
      for (let t = 0; t < count; t++) {
        const o = 84 + t * 50 + 12
        for (let k = 0; k < 9; k++) out[t * 9 + k] = buf.readFloatLE(o + k * 4)
      }
      return out
    }
  }
  const text = buf.subarray(0, 512).toString('latin1').trimStart()
  if (!text.startsWith('solid')) throw new Error('Not a valid STL file (binary size does not match and no ASCII header).')
  const values: number[] = []
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g
  const all = buf.toString('latin1')
  for (let m = re.exec(all); m; m = re.exec(all)) values.push(Number(m[1]), Number(m[2]), Number(m[3]))
  return new Float32Array(values.slice(0, values.length - (values.length % 9)))
}

export function meshStats(pos: Float32Array): MeshStats {
  const count = Math.floor(pos.length / 9)
  if (count === 0) throw new Error('The model has no triangles.')
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let area = 0
  let volume = 0
  const at = (i: number): number => pos[i] ?? 0
  for (let t = 0; t < count; t++) {
    const o = t * 9
    for (let k = 0; k < 9; k++) {
      const axis = k % 3
      const v = at(o + k)
      if (v < (min[axis] ?? 0)) min[axis] = v
      if (v > (max[axis] ?? 0)) max[axis] = v
    }
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [at(o), at(o + 1), at(o + 2), at(o + 3), at(o + 4), at(o + 5), at(o + 6), at(o + 7), at(o + 8)]
    const [ux, uy, uz] = [bx - ax, by - ay, bz - az]
    const [vx, vy, vz] = [cx - ax, cy - ay, cz - az]
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    // Signed volume of the tetrahedron with the origin; sums to the enclosed volume for a closed mesh.
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  const r = (v: number): number => Math.round(v * 1000) / 1000
  return {
    triangles: count,
    bboxMm: [0, 1, 2].map((i) => r((max[i] ?? 0) - (min[i] ?? 0))) as [number, number, number],
    minMm: [0, 1, 2].map((i) => r(min[i] ?? 0)) as [number, number, number],
    areaMm2: area,
    volumeMm3: Math.abs(volume),
  }
}

export function readStl(buf: Buffer): MeshStats {
  return meshStats(readStlPositions(buf))
}

/** Applies a 4x4 column-major transform to every vertex. */
export function transformPositions(pos: Float32Array, m: number[]): Float32Array {
  const out = new Float32Array(pos.length)
  const e = (i: number): number => m[i] ?? (i % 5 === 0 ? 1 : 0)
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] ?? 0
    const y = pos[i + 1] ?? 0
    const z = pos[i + 2] ?? 0
    out[i] = e(0) * x + e(4) * y + e(8) * z + e(12)
    out[i + 1] = e(1) * x + e(5) * y + e(9) * z + e(13)
    out[i + 2] = e(2) * x + e(6) * y + e(10) * z + e(14)
  }
  return out
}

export function writeBinaryStl(pos: Float32Array): Buffer {
  const count = Math.floor(pos.length / 9)
  const buf = Buffer.alloc(84 + count * 50)
  buf.write('SlicerX plate', 0, 'latin1')
  buf.writeUInt32LE(count, 80)
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50 + 12
    for (let k = 0; k < 9; k++) buf.writeFloatLE(pos[t * 9 + k] ?? 0, o + k * 4)
  }
  return buf
}
