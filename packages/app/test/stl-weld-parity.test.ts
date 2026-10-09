// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's weld of a binary STL (stl-scan.ts) is the engine's exact weld: the same positions in the same order and the
// same triangles. Both are held to one record, packages/geom/tests/fixtures/weld-parity.json, which the engine's test
// (packages/geom/tests/weld_parity.rs) checks from its side; a change to either weld fails one of the two.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanStl } from '../src/export/stl-scan'

const repo = join(__dirname, '..', '..', '..')
const record = JSON.parse(readFileSync(join(repo, 'packages/geom/tests/fixtures/weld-parity.json'), 'utf8')) as {
  files: { path: string; vertices: number; triangles: number; digest: string }[]
}

/** FNV-1a over the positions as little-endian f32, then the triangles as little-endian u32 (as the engine's test). */
function digest(positions: Float32Array, indices: Uint32Array): string {
  let h = 0x811c9dc5
  const eat = (bytes: Uint8Array) => {
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
  }
  eat(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength))
  eat(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength))
  return h.toString(16).padStart(8, '0')
}

describe("the app's STL weld", () => {
  it.each(record.files.map((f) => [f.path, f] as const))('is the engine\'s exact weld of %s', (_path, f) => {
    const m = scanStl(new Uint8Array(readFileSync(join(repo, f.path))))!
    expect(m).not.toBeNull()
    expect({ vertices: m.positions.length / 3, triangles: m.indices.length / 3, digest: digest(m.positions, m.indices) }).toEqual({
      vertices: f.vertices,
      triangles: f.triangles,
      digest: f.digest,
    })
  })
})
