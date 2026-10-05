// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP import: OpenCASCADE (the vendored occt-import-js build) reads the fixtures in fixtures/step,
// step-read.ts picks bodies, names and objects, and the geometry engine repairs and adds them through
// addAutoImport. The engine runs live when built, else replays fixtures/step-replies.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import init from '../../vendor/occt-import-js/lib/occt-import-js.mjs'
import type { StepConverter } from '../src/state/import-step'
import { addAutoImport, autoFormatOf, toBase64 } from '../src/state/import-auto'
import { readStep, STEP_MAX_MB, StepError, stepToObj, stepUnit, type Occt, type StepQuality } from '../src/state/step-read'
import { bounds, decompose, sizeOf } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('step-replies')

const dir = join(__dirname, 'fixtures', 'step')
const file = (name: string) => new Uint8Array(readFileSync(join(dir, name)))
const host = { slicer: { loadParts: async (name: string) => ({ id: name, name, parts: [] }) } } as unknown as Host

let occt: Occt
beforeAll(async () => {
  const wasm = join(__dirname, '..', '..', 'vendor', 'occt-import-js', 'lib', 'occt-import-js.wasm')
  occt = (await init({ locateFile: () => wasm })) as Occt
})

/** The worker's job, in process. */
const convert: StepConverter = async ({ name, data, quality }) => {
  const read = readStep(occt, new Uint8Array(data), name, quality as StepQuality | undefined)
  return { base64: toBase64(new TextEncoder().encode(stepToObj(read))), notes: read.notes, triangles: read.triangles, toleranceMm: read.toleranceMm, unit: read.unit }
}

const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

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

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], toast: null }))

describe('reading STEP files', () => {
  it('routes .step and .stp to the automatic import', () => {
    expect(autoFormatOf('a.STEP')).toBe('step')
    expect(autoFormatOf('b.stp')).toBe('step')
  })

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

  it('meshes coarser and finer on request', () => {
    const n = (q: StepQuality) => readStep(occt, file('bracket-inch.stp'), 'b.stp', q).triangles
    expect(n('coarser')).toBeLessThan(n('normal'))
    expect(n('finer')).toBeGreaterThan(n('normal'))
  })

  it('refuses empty, foreign and oversized files in plain words', () => {
    const fail = (bytes: Uint8Array) => {
      try {
        readStep(occt, bytes, 'x.step')
      } catch (e) {
        expect(e).toBeInstanceOf(StepError)
        return (e as Error).message
      }
      throw new Error('expected a failure')
    }
    expect(fail(new Uint8Array(0))).toBe('is empty.')
    expect(fail(file('empty.step'))).toMatch(/^has no solids or surfaces SlicerX can read/)
    expect(fail(new TextEncoder().encode('solid cube\nendsolid cube\n'))).toMatch(/^is not a STEP file/)
    expect(fail(new TextEncoder().encode('<?xml version="1.0"?><iso_10303_28/>'))).toMatch(/^is a STEP XML file/)
    expect(fail(new Uint8Array(STEP_MAX_MB * 1024 * 1024 + 1))).toBe(`is 100 MB. STEP files up to ${STEP_MAX_MB} MB can be opened.`)
  })
})

describe('adding STEP files to the plate', () => {
  it('adds an assembly as two repaired objects in millimeters', async () => {
    const ids = await addAutoImport(host, 'assembly.step', buffer(file('assembly.step')), undefined, convert)
    expect(ids).toHaveLength(2)
    const plate = get().plate
    expect(plate.map((p) => p.name)).toEqual(['assembly', 'cube'])
    // The engine names the parts of an OBJ object after the object and the group.
    expect(plate[0]!.parts.map((p) => p.name)).toEqual(['assembly base', 'assembly post'])
    expect(decompose(plate[0]!.transform).scale[0]).toBeCloseTo(1)
    const s = sizeOf(bounds(plate[0]!.parts, plate[0]!.transform)!)
    expect(s[0]).toBeCloseTo(20, 2)
    expect(s[2]).toBeCloseTo(25, 2)
    expect(get().toast?.action?.label).not.toBe('Use as millimeters')
  })

  it('adds an inch file at its real size and says it was converted', async () => {
    const [id] = await addAutoImport(host, 'bracket-inch.stp', buffer(file('bracket-inch.stp')), undefined, convert)
    const e = get().plate.find((p) => p.id === id)!
    expect(decompose(e.transform).scale[0]).toBeCloseTo(1)
    expect(sizeOf(bounds(e.parts, e.transform)!)[0]).toBeCloseTo(50.8, 2)
    expect(get().toast?.text).toMatch(/Converted from inches to millimeters/)
  })

  it('adds nothing when the file cannot be read', async () => {
    await expect(addAutoImport(host, 'empty.step', buffer(file('empty.step')), undefined, convert)).rejects.toThrow(/^empty\.step has no solids/)
    expect(get().plate).toHaveLength(0)
  })
})
