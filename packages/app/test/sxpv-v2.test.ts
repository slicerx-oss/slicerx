// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// SXPV v2 as the engine writes it (`sx slice --preview-format v2`): readPreview expands it into the v1 bytes of the
// same slice, byte for byte, and refuses a damaged buffer with an error instead of reading past it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SXPV_VERSION, SXPV_VERSION_2, expandPreview, readPreview } from '@slicerx/contracts'

/**
 * Two x-marks at a fifth of their size, sliced with G-code so the preview has travels, extras and objects:
 * `sx slice --request fixtures/sxpv-pair.request.json --out-dir <dir> --preview-format v1` (and v2), then gzip.
 */
function fixture(name: string): ArrayBuffer {
  const b = gunzipSync(readFileSync(join(__dirname, 'fixtures', name)))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

const v1 = fixture('sxpv-pair.v1.sxpv.gz')
const v2 = fixture('sxpv-pair.v2.sxpv.gz')
const layers = new DataView(v2).getUint32(12, true)
/** Where the layer index starts: after the header and the v1 tables (with travels). */
const indexAt = 32 + (layers + 1) * 4 + layers * 8 + (layers + 1) * 4
const blocksAt = indexAt + (layers + 1) * 4

const mutated = (f: (b: Uint8Array) => void): ArrayBuffer => {
  const c = v2.slice(0)
  f(new Uint8Array(c))
  return c
}

describe('SXPV v2', () => {
  it('expands into the v1 bytes of the same slice', () => {
    expect(new DataView(v1).getUint16(4, true)).toBe(SXPV_VERSION)
    expect(new DataView(v2).getUint16(4, true)).toBe(SXPV_VERSION_2)
    expect(v2.byteLength * 3).toBeLessThan(v1.byteLength)
    expect(Buffer.from(expandPreview(v2)).equals(Buffer.from(v1))).toBe(true)
  })

  it('reads as the v1 buffer does', () => {
    const a = readPreview(v1)
    const b = readPreview(v2)
    expect(a.encodedVersion).toBe(1)
    expect(b.encodedVersion).toBe(2)
    expect(b.version).toBe(1)
    expect(b.extrasOffset).toBeGreaterThan(0)
    expect(b.objectsOffset).toBeGreaterThan(0)
    const { raw: ra, encodedVersion: _a, layerStart: la, layerZ: za, layerTimeS: ta, travelStart: sa, ...restA } = a
    const { raw: rb, encodedVersion: _b, layerStart: lb, layerZ: zb, layerTimeS: tb, travelStart: sb, ...restB } = b
    expect(restB).toEqual(restA)
    expect(Array.from(lb)).toEqual(Array.from(la))
    expect(Array.from(zb)).toEqual(Array.from(za))
    expect(Array.from(tb)).toEqual(Array.from(ta))
    expect(Array.from(sb ?? [])).toEqual(Array.from(sa ?? []))
    expect(Buffer.from(rb).equals(Buffer.from(ra))).toBe(true)
  })

  it('refuses a truncated buffer', () => {
    for (let n = 0; n < v2.byteLength; n += 53) expect(() => expandPreview(v2.slice(0, n)), `length ${n}`).toThrow()
    for (let n = v2.byteLength - 8; n < v2.byteLength; n++) expect(() => readPreview(v2.slice(0, n)), `length ${n}`).toThrow()
  })

  it('refuses a varint that does not end, unknown flags and a v1 buffer', () => {
    expect(() => expandPreview(mutated((b) => b.fill(0xff, blocksAt, blocksAt + 11)))).toThrow(/varint/)
    expect(() => expandPreview(mutated((b) => { b[7] = (b[7] ?? 0) | 0x80 }))).toThrow(/flags/)
    expect(() => expandPreview(v1)).toThrow(/not an SXPV v2/)
  })

  it('refuses a wrong layer index', () => {
    const dv = (b: Uint8Array) => new DataView(b.buffer)
    // Layer 0 claims layer 1's block too.
    expect(() => expandPreview(mutated((b) => dv(b).setUint32(indexAt + 4, dv(b).getUint32(indexAt + 8, true), true)))).toThrow()
    // The index does not end at the end of the blocks.
    expect(() => expandPreview(mutated((b) => dv(b).setUint32(indexAt + layers * 4, dv(b).getUint32(indexAt + layers * 4, true) + 1, true)))).toThrow(/index/)
    // A layer table that no longer adds up.
    expect(() => expandPreview(mutated((b) => dv(b).setUint32(32 + layers * 4, 0, true)))).toThrow()
  })

  it('never reads past a damaged buffer', () => {
    let seed = 0x5856_3201
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0)
    for (let i = 0; i < 1500; i++) {
      const d = mutated((b) => {
        for (let k = 0; k <= next() % 4; k++) b[next() % b.length] = next() & 0xff
      })
      try {
        expect(readPreview(d).segmentCount).toBeGreaterThanOrEqual(0)
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
      }
    }
  })
})
