// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packed corner normals (src/normals.ts) against the shared test vectors in fixtures/mesh-normal-pack.json, which the
// engine's Rust copy is tested against too.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exactTriangle, NO_NORMAL, packNormal, packNormals, unpackNormal, unpackNormals } from '../src/normals'

interface Vectors {
  maxAngleDeg: number
  cases: { name: string; normal: [number, number, number]; packed: [number, number] }[]
}

const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'mesh-normal-pack.json'), 'utf8')) as Vectors

function pack(n: readonly number[]): [number, number] {
  const out = new Int16Array(2)
  packNormal(n[0]!, n[1]!, n[2]!, out, 0)
  return [out[0]!, out[1]!]
}

describe('packed corner normals', () => {
  it('has the six axes, the eight diagonals, a dozen others and no normal', () => {
    const names = vectors.cases.map((c) => c.name)
    expect(names.filter((n) => /^[+-][xyz]$/.test(n))).toHaveLength(6)
    expect(names.filter((n) => n.startsWith('diagonal'))).toHaveLength(8)
    expect(names.filter((n) => n.startsWith('arbitrary')).length).toBeGreaterThanOrEqual(12)
    expect(vectors.cases.some((c) => c.packed[0] === NO_NORMAL && c.packed[1] === NO_NORMAL)).toBe(true)
  })

  for (const c of vectors.cases) {
    it(`packs and unpacks ${c.name}`, () => {
      expect(pack(c.normal)).toEqual(c.packed)
      const n = [0, 0, 0]
      const valid = unpackNormal(c.packed, 0, n, 0)
      const zero = c.normal.every((v) => v === 0)
      expect(valid).toBe(!zero)
      if (zero) {
        expect(n).toEqual([0, 0, 0])
        return
      }
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 12)
      const dot = n[0]! * c.normal[0] + n[1]! * c.normal[1] + n[2]! * c.normal[2]
      const angle = (Math.acos(Math.min(1, dot / Math.hypot(...c.normal))) * 180) / Math.PI
      expect(angle).toBeLessThanOrEqual(vectors.maxAngleDeg)
      // a stored pair is stable: packing what it unpacks to gives it back
      expect(pack(n)).toEqual(c.packed)
    })
  }

  it('keeps every stored number in -32767..32767 and packs a vector that is not a number as no normal', () => {
    for (const c of vectors.cases) for (const v of c.packed) expect(v === NO_NORMAL || (v >= -32767 && v <= 32767)).toBe(true)
    expect(pack([Number.NaN, 0, 1])).toEqual([NO_NORMAL, NO_NORMAL])
    expect(pack([Number.POSITIVE_INFINITY, 0, 0])).toEqual([NO_NORMAL, NO_NORMAL])
  })

  it('counts a triangle exact only when all three corners have a normal', () => {
    const up = pack([0, 0, 1])
    const none = [NO_NORMAL, NO_NORMAL]
    const buf = Int16Array.from([...up, ...up, ...up, ...up, ...none, ...up, ...none, ...none, ...none])
    expect(exactTriangle(buf, 0)).toBe(true)
    expect(exactTriangle(buf, 1)).toBe(false)
    expect(exactTriangle(buf, 2)).toBe(false)
    // past the end of a short buffer
    expect(exactTriangle(buf, 3)).toBe(false)
  })

  it('packs and unpacks a whole buffer, nine numbers to six per triangle', () => {
    const corners = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 0.6, 0.8, 0, 0, -0.6, -0.8])
    const packed = packNormals(corners)
    expect(packed).toHaveLength(12)
    expect(Array.from(packed.slice(6, 8))).toEqual([NO_NORMAL, NO_NORMAL])
    const back = unpackNormals(packed)
    expect(back).toHaveLength(18)
    for (let i = 0; i < 18; i++) expect(back[i]!).toBeCloseTo(corners[i]!, 4)
  })
})
