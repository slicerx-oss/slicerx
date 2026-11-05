// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reading IGES files: the same OpenCASCADE build reads them (ReadIgesFile) and they come out in the shape a STEP read
// has: objects of touching bodies, names, colors, millimeters and notes. A file of loose trimmed surfaces, the way
// many CAD programs write IGES, is read as bodies of surfaces rather than refused. The fixtures come from
// fixtures/make-iges-fixtures.py.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { cadFormat, igesUnit, loadOcct, loadStepReader, readCad, readIges, StepError, stepInfo, toObj, type Occt, type StepQuality } from '../src/index.ts'

const file = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)))
const text = (s: string) => new TextEncoder().encode(s)

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

/** An IGES file of `records`, each padded to 72 columns and given its section letter and sequence number. */
function iges(records: [string, string][]): Uint8Array {
  const seq = new Map<string, number>()
  const lines = records.map(([section, body]) => {
    const n = (seq.get(section) ?? 0) + 1
    seq.set(section, n)
    return `${body.padEnd(72)}${section}${String(n).padStart(7, '0')}`
  })
  return text(`${lines.join('\n')}\n`)
}

let occt: Occt
beforeAll(async () => {
  occt = await loadOcct()
})

describe('telling IGES from STEP', () => {
  it('goes by the bytes first, then the name', () => {
    expect(cadFormat(file('assembly.igs'), 'assembly.igs')).toBe('iges')
    expect(cadFormat(file('assembly.step'), 'assembly.step')).toBe('step')
    // The bytes win over a wrong name.
    expect(cadFormat(file('assembly.igs'), 'assembly.step')).toBe('iges')
    expect(cadFormat(file('bracket-inch.stp'), 'bracket.iges')).toBe('step')
    // Bytes that are neither: the name decides, and no name means not a CAD file.
    expect(cadFormat(text('hello'), 'x.IGES')).toBe('iges')
    expect(cadFormat(text('hello'), 'x.igs')).toBe('iges')
    expect(cadFormat(text('hello'), 'x.STP')).toBe('step')
    expect(cadFormat(text('hello'), 'x.stl')).toBeNull()
    // Records without line breaks, as some old writers save them, and a byte order mark in front.
    const flat = text(new TextDecoder('latin1').decode(file('assembly.igs')).replace(/\r?\n/g, ''))
    expect(cadFormat(flat, 'x')).toBe('iges')
    expect(cadFormat(Uint8Array.from([0xef, 0xbb, 0xbf, ...file('assembly.igs')]), 'x')).toBe('iges')
  })

  it('reads the declared length unit from the global section', () => {
    expect(igesUnit(file('assembly.igs'))).toBe('millimeter')
    expect(igesUnit(file('bracket-inch.iges'))).toBe('inch')
    const g = (params: string) => iges([['S', ''], ['G', params]])
    // Default delimiters, then a file that names its own.
    expect(igesUnit(g(',,4Hpart,,,,32,38,6,308,15,,1.,4,2HFT,1,0.01;'))).toBe('foot')
    expect(igesUnit(g('1H/,1H#,4Hpa/t////32/38/6/308/15//1./10/2HCM/1/0.01#'))).toBe('centimeter')
    expect(igesUnit(g(',,,,,,32,38,6,308,15,,1.,6,1HM,1,0.01;'))).toBe('meter')
    // A unit given by name only (flag 3).
    expect(igesUnit(g(',,,,,,32,38,6,308,15,,1.,3,4HINCH,1,0.01;'))).toBe('inch')
    // A unit outside the list, or none.
    expect(igesUnit(g(',,,,,,32,38,6,308,15,,1.,8,3HMIL,1,0.01;'))).toBeNull()
    expect(igesUnit(iges([['S', '']]))).toBeNull()
  })
})

describe('reading IGES files', () => {
  it('keeps touching solids together as parts and the separate one as its own object, with names and colors', () => {
    const read = readIges(occt, file('assembly.igs'), 'assembly.igs')
    expect(read.unit).toBe('millimeter')
    expect(read.notes).toEqual([])
    expect(read.objects.map((o) => [o.name, o.bodies.map((b) => [b.name, b.color ?? null])])).toEqual([
      ['assembly', [['base', '#ff0000'], ['post', null]]],
      ['cube', [['cube', '#0040ff']]],
    ])
    expect(size(read.objects[1]!.bodies[0]!.positions).map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 10, 10])
    const all = read.objects.flatMap((o) => o.bodies).map((b) => size(b.positions))
    expect(all[1]![2]).toBeCloseTo(20, 3)
    expect(read.toleranceMm).toBe(0.01)
    expect(read.triangles).toBe(328)
  })

  it('joins a file of loose surfaces into a body, converts inches and says both', () => {
    const read = readIges(occt, file('bracket-inch.iges'), 'bracket-inch.iges')
    expect(read.unit).toBe('inch')
    expect(read.objects.map((o) => [o.name, o.bodies.map((b) => b.name)])).toEqual([['bracket-inch', ['bracket-inch']]])
    const s = size(read.objects[0]!.bodies[0]!.positions)
    expect(s[0]).toBeCloseTo(50.8, 3)
    expect(s[1]).toBeCloseTo(25.4, 3)
    expect(s[2]).toBeCloseTo(6.35, 3)
    expect(read.notes).toEqual(['Converted from inches to millimeters.', 'The file has surfaces and no solids, so they were joined into one body.'])
    expect(read.triangles).toBeGreaterThan(100)
  })

  it('joins loose surfaces into a body per group of touching ones', () => {
    // Twelve loose faces, six to a cube, the cubes 20 mm apart.
    const read = readIges(occt, file('cubes-faces.igs'), 'cubes-faces.igs')
    expect(read.objects.map((o) => [o.name, o.bodies.map((b) => [b.name, b.indices.length / 3])])).toEqual([
      ['cubes-faces 1', [['cubes-faces 1', 12]]],
      ['cubes-faces 2', [['cubes-faces 2', 12]]],
    ])
    for (const o of read.objects) expect(size(o.bodies[0]!.positions).map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 10, 10])
    expect(read.notes).toEqual(['The file has surfaces and no solids, so they were joined into 2 bodies.'])
    expect(read.unit).toBe('millimeter')
  })

  it('meshes coarser and finer on request', () => {
    const n = (q: StepQuality) => readIges(occt, file('bracket-inch.iges'), 'b.igs', q).triangles
    expect(n('coarser')).toBeLessThan(n('normal'))
    expect(n('finer')).toBeGreaterThan(n('normal'))
  })

  it('reads records without line breaks and a byte order mark in front like the plain file', () => {
    const plain = toObj(readIges(occt, file('assembly.igs'), 'a.igs'))
    const flat = text(new TextDecoder('latin1').decode(file('assembly.igs')).replace(/\r?\n/g, ''))
    expect(toObj(readIges(occt, flat, 'a.igs'))).toBe(plain)
    expect(toObj(readIges(occt, Uint8Array.from([0xef, 0xbb, 0xbf, ...file('assembly.igs')]), 'a.igs'))).toBe(plain)
  })

  it('reads a file of records without line breaks that ends in a newline, with its unit', () => {
    const flat = new TextDecoder('latin1').decode(file('bracket-inch.iges')).replace(/\r?\n/g, '')
    for (const end of ['\n', '\r\n']) {
      const bytes = text(flat + end)
      expect(igesUnit(bytes)).toBe('inch')
      const read = readIges(occt, bytes, 'bracket-inch.iges')
      expect(read.unit).toBe('inch')
      expect(read.notes[0]).toBe('Converted from inches to millimeters.')
    }
  })

  it('names objects without the extension when the name and the bytes disagree', () => {
    expect(readCad(occt, file('assembly.igs'), 'assembly.step').objects.map((o) => o.name)).toEqual(['assembly', 'cube'])
    expect(readCad(occt, file('bracket-inch.iges'), 'model.step').objects.map((o) => o.name)).toEqual(['model'])
    expect(readCad(occt, file('bracket-inch.stp'), 'bracket.igs').objects.map((o) => o.name)).toEqual(['bracket'])
  })

  it('reads the same through readCad and a loaded reader, whatever the file is called', async () => {
    const want = toObj(readIges(occt, file('assembly.igs'), 'assembly.igs'))
    expect(toObj(readCad(occt, file('assembly.igs'), 'assembly.igs'))).toBe(want)
    // STEP still reads as STEP through readCad.
    expect(readCad(occt, file('bracket-inch.stp'), 'bracket-inch.stp').unit).toBe('inch')
    const reader = await loadStepReader()
    expect(toObj(reader.read(file('assembly.igs'), { name: 'assembly.igs' }))).toBe(want)
    expect(stepInfo(reader.read(file('bracket-inch.iges'), { name: 'bracket-inch.iges' })).objects.map((o) => o.name)).toEqual(['bracket-inch'])
    reader.close()
  })

  it('refuses empty, foreign, compressed and broken files in plain words, each with its code', () => {
    const fail = (bytes: Uint8Array, name = 'x.igs', appName?: string) => {
      try {
        readCad(occt, bytes, name, 'normal', appName ? { appName } : {})
      } catch (e) {
        expect(e).toBeInstanceOf(StepError)
        return [(e as StepError).code, (e as Error).message]
      }
      throw new Error('expected a failure')
    }
    expect(fail(new Uint8Array(0))).toEqual(['empty', 'is empty.'])
    expect(fail(text('solid cube\nendsolid cube\n'))).toEqual(['not_iges', expect.stringMatching(/^is not an IGES file/)])
    expect(fail(text('solid cube\nendsolid cube\n'), 'x.iges')).toEqual(['not_iges', expect.stringMatching(/^is not an IGES file/)])
    expect(fail(iges([['C', 'compressed']]))).toEqual(['iges_compressed', expect.stringMatching(/^is a compressed IGES file/)])
    // A start and global section with nothing after them holds no geometry.
    expect(fail(iges([['S', 'nothing here'], ['G', ',,,,,,32,38,6,308,15,,1.,2,2HMM,1,0.01;']]), 'x.igs', 'SlicerX')).toEqual([
      'no_solids',
      expect.stringMatching(/^has no solids or surfaces SlicerX can read.*IGES entities SlicerX does not support/),
    ])
    const cut = file('assembly.igs').subarray(0, 20_000)
    expect(fail(cut)).toEqual(['unreadable', expect.stringMatching(/^could not be read\. It may be damaged, or it uses IGES entities this reader does not support/)])
    expect(fail(new Uint8Array(100 * 1024 * 1024 + 1))).toEqual(['too_large', 'is 100 MB. IGES files up to 100 MB can be opened.'])
  })
})
