// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The STL and the read-back facts: the same triangles as the OBJ, outward normals, boxes in millimeters.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadOcct, readStep, stepInfo, toObj, toStl, type Occt } from '../src/index.ts'

const file = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)))

let occt: Occt
beforeAll(async () => {
  occt = await loadOcct()
})

describe('STL from a STEP file', () => {
  it('has the triangles of the OBJ, at its vertices, with unit normals', () => {
    const read = readStep(occt, file('assembly.step'), 'assembly.step')
    const stl = toStl(read)
    const v = new DataView(stl.buffer)
    expect(new TextDecoder().decode(stl.subarray(0, 5))).not.toBe('solid')
    expect(v.getUint32(80, true)).toBe(read.triangles)
    expect(stl.length).toBe(84 + read.triangles * 50)
    const objVerts = toObj(read).split('\n').filter((l) => l.startsWith('v ')).map((l) => l.slice(2).split(' ').map(Number))
    const objFaces = toObj(read).split('\n').filter((l) => l.startsWith('f ')).map((l) => l.slice(2).split(' ').map((s) => Number(s) - 1))
    for (let t = 0; t < read.triangles; t += 37) {
      const at = 84 + t * 50
      const n = [0, 1, 2].map((k) => v.getFloat32(at + k * 4, true))
      expect(Math.hypot(...n)).toBeCloseTo(1, 5)
      for (let c = 0; c < 3; c++) {
        const p = [0, 1, 2].map((k) => v.getFloat32(at + 12 + c * 12 + k * 4, true))
        const want = objVerts[objFaces[t]![c]!]!
        p.forEach((x, k) => expect(x).toBeCloseTo(want[k]!, 3))
      }
    }
  })

  it('writes the same bytes every time', () => {
    const sha = (name: string) => createHash('sha256').update(toStl(readStep(occt, file(name), name))).digest('hex')
    expect(sha('assembly.step')).toBe(sha('assembly.step'))
    expect(sha('bracket-inch.stp')).toBe(sha('bracket-inch.stp'))
  })
})

describe('read-back info', () => {
  it('names objects and bodies with their triangle counts and boxes in mm', () => {
    const info = stepInfo(readStep(occt, file('bracket-inch.stp'), 'bracket-inch.stp'))
    expect(info.unit).toBe('inch')
    expect(info.objects).toHaveLength(1)
    const [o] = info.objects
    expect(o!.name).toBe('bracket-inch')
    expect(o!.triangles).toBe(info.triangles)
    expect(o!.bodies.map((b) => [b.name, b.color])).toEqual([['bracket', null]])
    const size = info.bounds!.max.map((h, k) => h - info.bounds!.min[k]!)
    expect(size[0]).toBeCloseTo(50.8, 3)
    expect(size[1]).toBeCloseTo(25.4, 3)
    expect(size[2]).toBeCloseTo(6.35, 3)
    // Centered on the origin by the read.
    info.bounds!.min.forEach((lo, k) => expect(lo + info.bounds!.max[k]!).toBeCloseTo(0, 3))
  })
})
