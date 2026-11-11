// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser engine joins a rib into a shelled hull and arrays it to the same mesh as the desktop engine. Both are held
// to one record, packages/geom/tests/fixtures/ship-hull-join.json, which the engine's test (packages/geom/tests/
// join_parity.rs) checks from its side; a change to either build's result fails one of the two.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { liveEngine, wasmGeom } from './geom-engine'

const repo = join(__dirname, '..', '..', '..')
const fixture = JSON.parse(readFileSync(join(repo, 'packages/geom/tests/fixtures/ship-hull-join.json'), 'utf8')) as {
  join: { target: { transform: number[] } } & Record<string, unknown>
  array: Record<string, unknown>
  record: { join: unknown; array: unknown }
}

interface Reply {
  mesh: { positions: number[]; indices: number[]; faces?: { ids: number[] } }
}

/** Counts and an FNV-1a digest of a reply's mesh: positions as f32, indices, then face ids, little-endian (as the engine's test). */
function summary(r: Reply): { vertices: number; triangles: number; digest: string } {
  let h = 0x811c9dc5
  const eat = (bytes: Uint8Array) => {
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
  }
  eat(new Uint8Array(Float32Array.from(r.mesh.positions).buffer))
  eat(new Uint8Array(Uint32Array.from([...r.mesh.indices, ...(r.mesh.faces?.ids ?? [])]).buffer))
  return { vertices: r.mesh.positions.length / 3, triangles: r.mesh.indices.length / 3, digest: h.toString(16).padStart(8, '0') }
}

describe.skipIf(!liveEngine)('the browser engine on a join and the array after it (a built engine)', () => {
  it('matches the desktop engine', async () => {
    const geom = await wasmGeom()
    const joined = await geom.call<Reply>('shape.extrude', fixture.join)
    expect(summary(joined)).toEqual(fixture.record.join)
    const arrayed = await geom.call<Reply>('array', { ...fixture.array, mesh: { mesh: joined.mesh, transform: fixture.join.target.transform } })
    expect(summary(arrayed)).toEqual(fixture.record.array)
  })
})
