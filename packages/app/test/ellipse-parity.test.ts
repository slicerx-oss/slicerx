// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The wasm engine answers the ellipse requests in packages/geom/tests/fixtures/ellipse-parity.json number for number
// as the native engine does: the same digest over every number of each reply (packages/geom/tests/ellipse_parity.rs
// records them). Runs where the engine is built, as the web job builds it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { liveEngine, wasmGeom } from './geom-engine'

interface Case { op: string; request: unknown; numbers: number; digest: string }

const record = JSON.parse(readFileSync(join(__dirname, '..', '..', 'geom', 'tests', 'fixtures', 'ellipse-parity.json'), 'utf8')) as { cases: Case[] }

/** FNV-1a over every number as little-endian f64 bits, in the reply's text order, as the native test takes it. */
function digest(v: unknown): { numbers: number; digest: string } {
  let h = 0xcbf29ce484222325n
  let numbers = 0
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  const walk = (x: unknown): void => {
    if (typeof x === 'number') {
      view.setFloat64(0, x, true)
      for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn
      numbers++
    } else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') Object.values(x).forEach(walk)
  }
  walk(v)
  return { numbers, digest: h.toString(16).padStart(16, '0') }
}

describe.skipIf(!liveEngine)('ellipses in the wasm engine', () => {
  it('answer as the native engine does', async () => {
    const geom = await wasmGeom()
    for (const c of record.cases) {
      const reply = await geom.call(c.op, c.request)
      expect(digest(reply), c.op).toEqual({ numbers: c.numbers, digest: c.digest })
    }
  })
})
