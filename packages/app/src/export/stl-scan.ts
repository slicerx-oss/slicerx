// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads a binary STL straight into typed arrays, its corners welded where they are the same point, in the order they
// first appear (the geometry engine's own exact weld, before its repair). The plate shows the model from these at
// once; the engine's import (repair, unit, loose bodies) follows and replaces them only when it changed something.
// No imports, so the project worker can load it on its own.

export interface ScannedStl {
  positions: Float32Array
  indices: Uint32Array
}

/** Whether these bytes are a binary STL: the size its header declares. An ASCII STL is left to the engine. */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)
  return bytes.length === 84 + count * 50
}

/** The welded mesh of a binary STL, or null when it is not one or has a corner that is not a finite number. */
export function scanStl(bytes: Uint8Array): ScannedStl | null {
  if (!isBinaryStl(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(80, true)
  const corners = count * 3
  // Open addressing on the corner's three float bit patterns; a table at least twice the corners keeps chains short.
  let size = 1
  while (size < corners * 2) size <<= 1
  const mask = size - 1
  const table = new Int32Array(size).fill(-1)
  const positions = new Float32Array(corners * 3)
  const bits = new Uint32Array(positions.buffer)
  const indices = new Uint32Array(corners)
  const f = new Float32Array(3)
  const fb = new Uint32Array(f.buffer)
  let n = 0
  for (let t = 0; t < count; t++) {
    const at = 84 + t * 50 + 12
    for (let c = 0; c < 3; c++) {
      const o = at + c * 12
      // + 0 makes -0 the same point as 0, as the engine's comparison does.
      f[0] = view.getFloat32(o, true) + 0
      f[1] = view.getFloat32(o + 4, true) + 0
      f[2] = view.getFloat32(o + 8, true) + 0
      if (!Number.isFinite(f[0]!) || !Number.isFinite(f[1]!) || !Number.isFinite(f[2]!)) return null
      const x = fb[0]!
      const y = fb[1]!
      const z = fb[2]!
      let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d)) & mask
      let found = -1
      for (;;) {
        const v = table[h]!
        if (v < 0) break
        if (bits[v * 3] === x && bits[v * 3 + 1] === y && bits[v * 3 + 2] === z) {
          found = v
          break
        }
        h = (h + 1) & mask
      }
      if (found < 0) {
        found = n++
        table[h] = found
        bits[found * 3] = x
        bits[found * 3 + 1] = y
        bits[found * 3 + 2] = z
      }
      indices[t * 3 + c] = found
    }
  }
  return { positions: positions.slice(0, n * 3), indices }
}

/** Whether two meshes are the same arrays, value for value. */
export function sameMesh(a: { positions: ArrayLike<number>; indices: ArrayLike<number> }, b: { positions: ArrayLike<number>; indices: ArrayLike<number> }): boolean {
  if (a.positions.length !== b.positions.length || a.indices.length !== b.indices.length) return false
  for (let i = 0; i < a.indices.length; i++) if (a.indices[i] !== b.indices[i]) return false
  for (let i = 0; i < a.positions.length; i++) if (a.positions[i] !== b.positions[i]) return false
  return true
}
