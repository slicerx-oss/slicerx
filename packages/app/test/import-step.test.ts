// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP and IGES import: @slicerx/step-reader reads its fixtures (packages/step-reader/test/fixtures) into bodies, names and
// objects, and the geometry engine repairs and adds them through addAutoImport. The engine runs live when built, else
// replays fixtures/step-replies.json. The reader's own behavior is tested in that package.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { loadOcct, readCad, readStep, StepError, toObj, type Occt, type StepQuality } from '@slicerx/step-reader'
import type { StepConverter } from '../src/state/import-step'
import { addAutoImport, autoFormatOf, toBase64 } from '../src/state/import-auto'
import { bounds, decompose, sizeOf } from '../src/plate/transform'
import { appStore, get, set } from '../src/state/store'
import { resolveSlots } from '../src/filament/slots'
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
  const read = readCad(occt, new Uint8Array(data), name, quality as StepQuality | undefined, { appName: 'SlicerX' })
  return { base64: toBase64(new TextEncoder().encode(toObj(read, { colors: false }))), notes: read.notes, triangles: read.triangles, toleranceMm: read.toleranceMm, unit: read.unit }
}

const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], toast: null, openNote: null }))

describe('reading STEP files', () => {
  it('routes .step and .stp to the automatic import', () => {
    expect(autoFormatOf('a.STEP')).toBe('step')
    expect(autoFormatOf('b.stp')).toBe('step')
  })

  it('routes .igs and .iges to the automatic import', () => {
    expect(autoFormatOf('a.igs')).toBe('iges')
    expect(autoFormatOf('b.IGES')).toBe('iges')
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

describe('adding IGES files to the plate', () => {
  it('adds an assembly of solids as two repaired objects in millimeters, with their names', async () => {
    const ids = await addAutoImport(host, 'assembly.igs', buffer(file('assembly.igs')), undefined, convert)
    expect(ids).toHaveLength(2)
    const plate = get().plate
    expect(plate.map((p) => p.name)).toEqual(['assembly', 'cube'])
    expect(plate[0]!.parts.map((p) => p.name)).toEqual(['assembly base', 'assembly post'])
    const s = sizeOf(bounds(plate[0]!.parts, plate[0]!.transform)!)
    expect(s[0]).toBeCloseTo(20, 2)
    expect(s[2]).toBeCloseTo(25, 2)
  })

  it('adds a file of loose surfaces in inches as one object at its real size, and says what it did', async () => {
    const [id] = await addAutoImport(host, 'bracket-inch.iges', buffer(file('bracket-inch.iges')), undefined, convert)
    const e = get().plate.find((p) => p.id === id)!
    expect(get().plate).toHaveLength(1)
    expect(decompose(e.transform).scale[0]).toBeCloseTo(1)
    const s = sizeOf(bounds(e.parts, e.transform)!)
    expect(s[0]).toBeCloseTo(50.8, 2)
    expect(s[1]).toBeCloseTo(25.4, 2)
    expect(s[2]).toBeCloseTo(6.35, 2)
    // The engine's repair closes the seams between the surfaces.
    expect(get().openNote?.text).toMatch(/^bracket-inch\.iges: Converted from inches to millimeters\. The file has surfaces and no solids, so they were joined into one body\. Repaired: closed \d+ holes\.$/)
  })

  it('adds nothing when the file is not IGES', async () => {
    await expect(addAutoImport(host, 'not.igs', buffer(new TextEncoder().encode('solid x\nendsolid x\n')), undefined, convert)).rejects.toThrow(/^not\.igs is not an IGES file/)
    expect(get().plate).toHaveLength(0)
  })
})

describe('STEP body colors as filaments', () => {
  /** The worker's job with the body colors it sends beside the OBJ (step-worker.ts). */
  const colored: StepConverter = async (o) => {
    const read = readCad(occt, new Uint8Array(o.data), o.name, o.quality as StepQuality | undefined, { appName: 'SlicerX' })
    const colors = read.objects.map((x) => x.bodies.map((b) => b.color ?? null))
    return { ...(await convert(o)), ...(colors.some((x) => x.some(Boolean)) ? { colors } : {}) }
  }
  // the engine's handle lists each part with the slot it loaded on, as the real one does
  const slots = { slicer: { loadParts: async (name: string, parts: { name: string; slot: number; indices: Uint32Array }[]) => ({ id: name, name, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })) }) } } as unknown as Host
  /** Each part's slot after the person's or the auto pick's override, by part name. */
  const printsOn = () => Object.fromEntries(get().plate.flatMap((e) => e.handle.parts.map((p) => [p.name, e.slotOverrides?.[p.name] ?? p.slot])))

  beforeEach(() => set({ printerSlots: [], slotSetup: {}, fileSlotColors: [] }))

  it('puts each colored body on a new filament of its color and leaves the uncolored one on filament 1', async () => {
    await addAutoImport(slots, 'assembly-colors.step', buffer(file('assembly-colors.step')), undefined, colored)
    expect(printsOn()).toEqual({ 'assembly-colors base': 2, 'assembly-colors post': 1, cube: 3 })
    // the new filaments show the bodies' colors, as an OBJ's colors do
    const rail = resolveSlots(get())
    expect(rail.map((r) => [r.index, r.color, r.source])).toEqual([
      [1, rail[0]!.color, rail[0]!.source],
      [2, '#ff0000', 'model'],
      [3, '#0040ff', 'model'],
    ])
    const note = get().openNote!
    expect(note.text).toBe("assembly-colors.step: Added filaments 2 (Red) and 3 (Blue) for the file's colors. Split into 2 objects.")
    expect(note.action?.label).toBe('Use one filament')
    // the colors are the point of this note, so it takes two lines before Details
    expect(note.wrap).toBe(true)
    // the action takes the added filaments back: every body on filament 1, and the rail is one filament again
    note.action!.run()
    expect(printsOn()).toEqual({ 'assembly-colors base': 1, 'assembly-colors post': 1, cube: 1 })
    expect(resolveSlots(get()).filter((r) => r.used).map((r) => r.index)).toEqual([1])
  })

  it('matches a loaded spool close to a color, and keeps to the slots the printer holds', async () => {
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#C12E1F' }, { id: 'A2', material: 'PLA', color: '#101010' }] })
    await addAutoImport(slots, 'assembly-colors.step', buffer(file('assembly-colors.step')), undefined, colored)
    // red on the red spool; blue has no close spool and no slot left, so it takes the nearest; the uncolored post the
    // auto-picked spool, the first PLA one
    expect(printsOn()).toEqual({ 'assembly-colors base': 1, 'assembly-colors post': 1, cube: 2 })
    expect(get().openNote?.text).toBe("assembly-colors.step: The file has 2 colors and the printer holds 2, so 1 prints with the nearest filament's color. Split into 2 objects.")
    expect(get().openNote?.action?.label).not.toBe('Use one filament')
  })

  it('maps the solid colors of an IGES file the same way', async () => {
    await addAutoImport(slots, 'assembly.igs', buffer(file('assembly.igs')), undefined, colored)
    expect(printsOn()).toEqual({ 'assembly base': 2, 'assembly post': 1, cube: 3 })
    expect(get().openNote?.text).toBe("assembly.igs: Added filaments 2 (Red) and 3 (Blue) for the file's colors. Split into 2 objects.")
  })

  it('opens a file without colors as before', async () => {
    await addAutoImport(slots, 'assembly.step', buffer(file('assembly.step')), undefined, colored)
    expect(Object.values(printsOn())).toEqual([1, 1, 1])
    expect(get().openNote?.text).toBe('assembly.step: Split into 2 objects.')
  })
})
