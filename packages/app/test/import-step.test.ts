// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP import: @slicerx/step-reader reads its fixtures (packages/step-reader/test/fixtures) into bodies, names and
// objects, and the geometry engine repairs and adds them through addAutoImport. The engine runs live when built, else
// replays fixtures/step-replies.json. The reader's own behavior is tested in that package.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { loadOcct, readStep, StepError, toObj, type Occt, type StepQuality } from '@slicerx/step-reader'
import type { StepConverter } from '../src/state/import-step'
import { addAutoImport, autoFormatOf, toBase64 } from '../src/state/import-auto'
import { bounds, decompose, sizeOf } from '../src/plate/transform'
import { appStore, get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('step-replies')

const dir = join(__dirname, '..', '..', 'step-reader', 'test', 'fixtures')
const file = (name: string) => new Uint8Array(readFileSync(join(dir, name)))
const host = { slicer: { loadParts: async (name: string) => ({ id: name, name, parts: [] }) } } as unknown as Host

let occt: Occt
beforeAll(async () => {
  occt = await loadOcct()
})

/** The worker's job, in process (step-worker.ts). */
const convert: StepConverter = async ({ name, data, quality }) => {
  const read = readStep(occt, new Uint8Array(data), name, quality as StepQuality | undefined, { appName: 'SlicerX' })
  return { base64: toBase64(new TextEncoder().encode(toObj(read, { colors: false }))), notes: read.notes, triangles: read.triangles, toleranceMm: read.toleranceMm, unit: read.unit }
}

const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], toast: null, openNote: null }))

describe('reading STEP files', () => {
  it('routes .step and .stp to the automatic import', () => {
    expect(autoFormatOf('a.STEP')).toBe('step')
    expect(autoFormatOf('b.stp')).toBe('step')
  })

  it('names the app in a refusal, as before the reader moved into its package', () => {
    expect(() => readStep(occt, file('empty.step'), 'empty.step', 'normal', { appName: 'SlicerX' })).toThrow(StepError)
    expect(() => readStep(occt, file('empty.step'), 'empty.step', 'normal', { appName: 'SlicerX' })).toThrow(/^has no solids or surfaces SlicerX can read/)
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
    expect(get().openNote?.action?.label).not.toBe('Use as millimeters')
  })

  it('adds an inch file at its real size and says it was converted', async () => {
    const [id] = await addAutoImport(host, 'bracket-inch.stp', buffer(file('bracket-inch.stp')), undefined, convert)
    const e = get().plate.find((p) => p.id === id)!
    expect(decompose(e.transform).scale[0]).toBeCloseTo(1)
    expect(sizeOf(bounds(e.parts, e.transform)!)[0]).toBeCloseTo(50.8, 2)
    expect(get().openNote?.text).toMatch(/Converted from inches to millimeters/)
  })

  it('says what an assembly became as its objects show, so it never talks over the next file', async () => {
    // A file dropped as soon as the assembly shows ends with its own note, not the assembly's arriving after it.
    let shown: string | undefined
    let seen = false
    const off = appStore.subscribe((s, prev) => {
      if (seen || s.plate.length <= prev.plate.length) return
      seen = true
      queueMicrotask(() => (shown = get().openNote?.text ?? ''))
    })
    try {
      await addAutoImport(host, 'assembly.step', buffer(file('assembly.step')), undefined, convert)
    } finally {
      off()
    }
    expect(shown).toBe('assembly.step: Split into 2 objects.')
    await addAutoImport(host, 'bracket-inch.stp', buffer(file('bracket-inch.stp')), undefined, convert)
    expect(get().openNote?.text).toMatch(/^bracket-inch\.stp: Converted from inches to millimeters/)
  })

  it('adds nothing when the file cannot be read', async () => {
    await expect(addAutoImport(host, 'empty.step', buffer(file('empty.step')), undefined, convert)).rejects.toThrow(/^empty\.step has no solids/)
    expect(get().plate).toHaveLength(0)
  })
})
