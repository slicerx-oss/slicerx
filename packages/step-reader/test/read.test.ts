// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reading STEP files: OpenCASCADE (the build in src/) reads the fixtures, read.ts picks bodies, names and objects, and
// convert.ts writes the OBJ. golden.json holds what the app's own reader made of the fixtures before it moved into
// this package (the SHA-256 of its OBJ text, triangle counts and names), so the package is held to the same output.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadOcct, readStep, STEP_MAX_MB, StepError, stepUnit, toLocalOrigin, toObj, type Occt, type StepQuality } from '../src/index.ts'
import golden from './golden.json' with { type: 'json' }

const dir = join(import.meta.dirname, 'fixtures')
const file = (name: string) => new Uint8Array(readFileSync(join(dir, name)))

function size(positions: Float64Array): number[] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, positions[i + k]!)
      hi[k] = Math.max(hi[k]!, positions[i + k]!)
    }
  }
  return hi.map((h, k) => h - lo[k]!)
}

let occt: Occt
beforeAll(async () => {
  occt = await loadOcct()
})

describe('the same output as the app reader before the move', () => {
  for (const [key, want] of Object.entries(golden)) {
    const [name, quality] = key.split(':') as [string, StepQuality]
    it(`${name} at ${quality}: same OBJ bytes, triangles, names and notes`, () => {
      const read = readStep(occt, file(name), name, quality, { appName: 'SlicerX' })
      const obj = toObj(read)
      expect(createHash('sha256').update(obj).digest('hex')).toBe(want.objSha256)
      expect(Buffer.byteLength(obj)).toBe(want.objBytes)
      expect(read.triangles).toBe(want.triangles)
      expect(read.toleranceMm).toBe(want.toleranceMm)
      expect(read.unit).toBe(want.unit)
      expect(read.notes).toEqual(want.notes)
      expect(read.objects.map((o) => ({ name: o.name, bodies: o.bodies.map((b) => [b.name, b.indices.length / 3]) }))).toEqual(want.objects)
    })
  }
})

describe('reading STEP files', () => {
  it('reads the declared length unit', () => {
    expect(stepUnit(file('assembly.step'))).toBe('millimeter')
    expect(stepUnit(file('bracket-inch.stp'))).toBe('inch')
  })

  it('keeps touching bodies together as parts and the separate one as its own object, with names', () => {
    const read = readStep(occt, file('assembly.step'), 'assembly.step')
    expect(read.objects.map((o) => o.name)).toEqual(['assembly', 'cube'])
    expect(read.objects[0]!.bodies.map((b) => b.name)).toEqual(['base', 'post'])
    expect(read.objects[1]!.bodies.map((b) => b.name)).toEqual(['cube'])
    expect(size(read.objects[1]!.bodies[0]!.positions).map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 10, 10])
    expect(read.toleranceMm).toBe(0.01)
    expect(read.triangles).toBeGreaterThan(100)
    // No colors in the file, none on the bodies.
    expect(read.objects.flatMap((o) => o.bodies).some((b) => 'color' in b)).toBe(false)
  })

  it('converts an inch file to millimeters', () => {
    const read = readStep(occt, file('bracket-inch.stp'), 'bracket-inch.stp')
    expect(read.objects).toHaveLength(1)
    expect(read.objects[0]!.name).toBe('bracket-inch')
    const s = size(read.objects[0]!.bodies[0]!.positions)
    expect(s[0]).toBeCloseTo(50.8, 3)
    expect(s[1]).toBeCloseTo(25.4, 3)
    expect(s[2]).toBeCloseTo(6.35, 3)
    expect(read.notes[0]).toBe('Converted from inches to millimeters.')
  })

  it('reads a file saved with a UTF-8 byte order mark the same as one without', () => {
    const bom = file('bracket-inch-bom.stp')
    expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(stepUnit(bom)).toBe('inch')
    const plain = readStep(occt, file('bracket-inch.stp'), 'bracket-inch.stp', 'normal', { appName: 'SlicerX' })
    const read = readStep(occt, bom, 'bracket-inch.stp', 'normal', { appName: 'SlicerX' })
    expect(toObj(read)).toBe(toObj(plain))
    expect({ ...read, objects: read.objects.map((o) => o.name) }).toEqual({ ...plain, objects: plain.objects.map((o) => o.name) })
    // The caller's bytes are left as they were.
    expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('meshes coarser and finer on request', () => {
    const n = (q: StepQuality) => readStep(occt, file('bracket-inch.stp'), 'b.stp', q).triangles
    expect(n('coarser')).toBeLessThan(n('normal'))
    expect(n('finer')).toBeGreaterThan(n('normal'))
  })

  it('refuses empty, foreign and oversized files in plain words, each with its code', () => {
    const fail = (bytes: Uint8Array, appName?: string) => {
      try {
        readStep(occt, bytes, 'x.step', 'normal', appName ? { appName } : {})
      } catch (e) {
        expect(e).toBeInstanceOf(StepError)
        return [(e as StepError).code, (e as Error).message]
      }
      throw new Error('expected a failure')
    }
    expect(fail(new Uint8Array(0))).toEqual(['empty', 'is empty.'])
    expect(fail(file('empty.step'), 'SlicerX')).toEqual(['no_solids', expect.stringMatching(/^has no solids or surfaces SlicerX can read/)])
    expect(fail(file('empty.step'))).toEqual(['no_solids', expect.stringMatching(/^has no solids or surfaces this reader can read/)])
    expect(fail(new TextEncoder().encode('solid cube\nendsolid cube\n'))).toEqual(['not_step', expect.stringMatching(/^is not a STEP file/)])
    expect(fail(new TextEncoder().encode('<?xml version="1.0"?><iso_10303_28/>'))).toEqual(['step_xml', expect.stringMatching(/^is a STEP XML file/)])
    // A byte order mark alone is an empty file, and one in front of another format is still that format.
    const bom = (s: string) => Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(s)])
    expect(fail(bom(''))).toEqual(['empty', 'is empty.'])
    expect(fail(bom('solid cube\nendsolid cube\n'))).toEqual(['not_step', expect.stringMatching(/^is not a STEP file/)])
    expect(fail(bom('<?xml version="1.0"?><iso_10303_28/>'))).toEqual(['step_xml', expect.stringMatching(/^is a STEP XML file/)])
    expect(fail(new Uint8Array(STEP_MAX_MB * 1024 * 1024 + 1))).toEqual(['too_large', `is 100 MB. STEP files up to ${STEP_MAX_MB} MB can be opened.`])
  })
})

describe('a STEP model far from the origin', () => {
  it('keeps its small features once its meshes are 32-bit floats', () => {
    // A 0.01 mm step on a body 8 km out, and a second body 25 mm beside it: one 32-bit float there is half a millimeter.
    const far = 8_000_000
    const a = { name: 'a', positions: Float64Array.from([far, far, 0, far + 10, far, 0, far + 10.01, far + 10, 0]), indices: Uint32Array.from([0, 1, 2]) }
    const b = { name: 'b', positions: Float64Array.from([far + 25, far, 0, far + 35, far, 0, far + 35, far + 10, 5]), indices: Uint32Array.from([0, 1, 2]) }
    toLocalOrigin([a, b])
    const fa = Float32Array.from(a.positions)
    const fb = Float32Array.from(b.positions)
    expect(fa[6]! - fa[3]!).toBeCloseTo(0.01, 4)
    expect(fb[0]! - fa[0]!).toBeCloseTo(25, 4)
    // The shared box is centered on the origin.
    expect(Math.min(fa[0]!, fb[0]!) + Math.max(fa[6]!, fb[6]!)).toBeCloseTo(0, 4)
    expect(Math.min(...fa.filter((_, i) => i % 3 === 2), ...fb.filter((_, i) => i % 3 === 2)) + Math.max(...fb.filter((_, i) => i % 3 === 2))).toBeCloseTo(0, 4)
    // Without it the step is gone.
    const raw = Float32Array.from([far + 10, far + 10.01])
    expect(raw[1]! - raw[0]!).toBe(0)
  })
})
