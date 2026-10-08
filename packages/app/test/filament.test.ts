// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { deltaE2000, extruderCount, flushInputs, flushMatrix, flushValues, flushVolume, FLUSH_MAX, measuredFlush, minFlushFor, parseHex, printerMinFlush, loadFlushData, variantIndex } from '../src/filament/flush'
import { flushPlan, materialType, resetSlots, slotFinish, resolveSlots, setFlushManual, setSlot, slotConfig, slotOverridesFor, swapPlateSlots } from '../src/filament/slots'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

beforeAll(() => loadFlushData())

function entry(id: string, slots: number[], colors: string[] = []): PlateEntry {
  const handle: MeshHandle = { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: slots.map((slot, i) => ({ name: `p${i}`, slot, triangles: 12 })) }
  return { id, name: id, handle, parts: [], colors, transform: [] }
}

beforeEach(() => {
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', printerSlots: [], slotSetup: {}, slotMatch: {}, fileSlotColors: [], flush: { multiplier: 1, manual: {} } })
})

describe('flush volumes', () => {
  it('matches the color model on reference pairs', () => {
    const c = { w: '#ffffff', k: '#000000', r: '#ff0000', b: '#0000ff', g: '#808080', y: '#ffff00' }
    const pairs: [keyof typeof c, keyof typeof c, number][] = [['w', 'k', 80], ['k', 'w', 560], ['w', 'r', 262], ['r', 'w', 586], ['r', 'b', 237], ['g', 'k', 60], ['y', 'b', 266]]
    for (const [a, b, want] of pairs) expect(flushVolume(c[a], c[b]), `${a} to ${b}`).toBe(want)
  })

  it('takes the measured volume Orca ships for colors near its twelve, exactly as the table has it', () => {
    // Rows of resources/flush/flush_data_standard.txt (OrcaSlicer 2.4.2).
    expect(flushVolume('#000000', '#545454')).toBe(236)
    expect(flushVolume('#C12E1F', '#000000')).toBe(26)
    expect(flushVolume('#00AE42', '#D1D3D5')).toBe(266)
    expect(flushVolume('#545454', '#5E43B7')).toBe(56)
    // A color within delta E 5 of a measured one counts as it, so a near red after black is the red row.
    expect(deltaE2000(parseHex('#C12E1F')!, parseHex('#C22F20')!)).toBeLessThan(5)
    expect(flushVolume('#C22F20', '#010101')).toBe(26)
    expect(measuredFlush(parseHex('#ff0000')!, parseHex('#0000ff')!)).toBeNull()
    // Measured pairs also take the printer minimum.
    expect(flushVolume('#000000', '#545454', 63)).toBe(299)
  })

  it('uses the dual nozzle measured sets for nozzle_flush_dataset 1 and 2, without adding the printer minimum', () => {
    // Rows of flush_data_dual_standard.txt and flush_data_dual_highflow.txt (OrcaSlicer 2.4.2).
    const std = measuredFlush(parseHex('#000000')!, parseHex('#FFFFFF')!, 1)
    const hf = measuredFlush(parseHex('#000000')!, parseHex('#FFFFFF')!, 2)
    expect(std).not.toBeNull()
    expect(hf).not.toBeNull()
    expect(flushVolume('#000000', '#FFFFFF', 63, 1)).toBe(Math.trunc(std!))
    expect(flushVolume('#000000', '#FFFFFF', 63, 2)).toBe(Math.trunc(hf!))
    // The single nozzle set has no white in it, so the same pair falls back to the model plus the minimum there.
    expect(measuredFlush(parseHex('#000000')!, parseHex('#FFFFFF')!, 0)).toBeNull()
    expect(flushVolume('#000000', '#FFFFFF', 63, 0)).toBe(560 + 63)
    // A pair outside the dual tables takes the model, the minimum, and Orca's 1.3 for a dark target (a near black target counts).
    expect(measuredFlush(parseHex('#123456')!, parseHex('#654321')!, 1)).toBeNull()
  })

  it('computes the printer minimum as Bambu Studio and Orca do (nozzle volume less the long retraction)', () => {
    const p1s = { nozzleVolume: 107, level: 2, machineActivated: false, machineRetract: 18, dataset: 0 }
    // Filament level, a filament that cuts with a long retraction and leaves the distance to the printer: 107 - pi*1.75^2/4*18 = 63.7, cut to 63.
    expect(minFlushFor(p1s, { activated: true, retract: null })).toBe(63)
    expect(minFlushFor(p1s, { activated: true, retract: 10 })).toBe(107 - Math.ceil(Math.PI * 1.75 * 1.75 / 4 * 10))
    expect(minFlushFor(p1s, { activated: false, retract: 18 })).toBe(107)
    // Machine level uses the machine's distance only where the machine and the filament both agree.
    expect(minFlushFor({ ...p1s, level: 1, machineActivated: true }, { activated: true, retract: 5 })).toBe(63)
    expect(minFlushFor({ ...p1s, level: 1, machineActivated: false }, { activated: true, retract: 5 })).toBe(107)
    expect(minFlushFor({ ...p1s, level: 0 }, { activated: true, retract: 5 })).toBe(107)
    const fromConfig = flushInputs({ nozzle_volume: [107], enable_long_retraction_when_cut: 2, filament_long_retractions_when_cut: [true, false] }, 2)
    expect(fromConfig.mins).toEqual([63, 107])
  })

  it('needs more to go from dark to light than from light to dark, and never less than 60', () => {
    expect(flushVolume('#000000', '#ffffff')).toBeGreaterThan(flushVolume('#ffffff', '#000000'))
    expect(flushVolume('#123456', '#123457')).toBe(60)
  })

  it('adds the printer minimum, clamps at the maximum and treats transparent as white', () => {
    expect(flushVolume('#ffffff', '#000000', 107)).toBe(187)
    expect(flushVolume('#000000', '#ffffff', 99999)).toBe(FLUSH_MAX)
    expect(flushVolume('#ffffff00', '#000000')).toBe(flushVolume('#ffffff', '#000000'))
  })

  it('takes the printer nozzle volume as the base of every change', () => {
    expect(printerMinFlush([107])).toBe(107)
    expect(printerMinFlush('0')).toBe(0)
    expect(printerMinFlush(undefined)).toBe(0)
    const plain = flushMatrix(['#ffffff', '#000000'])
    const x1c = flushMatrix(['#ffffff', '#000000'], undefined, 107)
    expect(x1c[0]![1]).toBe(plain[0]![1]! + 107)
    expect(x1c[0]![0]).toBe(0)
  })

  it('builds a square matrix with a zero diagonal and typed values; the multiplier is not baked in', () => {
    const m = flushMatrix(['#ffffff', '#000000', '#ff0000'])
    expect(m).toHaveLength(3)
    m.forEach((row, i) => expect(row[i]).toBe(0))
    expect(flushMatrix(['#ffffff', '#000000'], { multiplier: 1, manual: { '1>2': 500 } })[0]![1]).toBe(500)
    expect(flushValues(['#ffffff', '#000000'], { multiplier: 2, manual: { '1>2': 500 } })).toEqual([0, 500, 560, 0])
  })

  it('gives unparseable colors the default', () => {
    expect(flushVolume('nonsense', '#ffffff')).toBe(280)
  })
})

describe('slots', () => {
  it('reads the material type out of the printer strings', () => {
    expect(materialType('PLA Basic')).toBe('PLA')
    expect(materialType('PETG-CF')).toBe('PETG')
    expect(materialType('Support for ABS')).toBe('ABS')
    expect(materialType(undefined)).toBe('PLA')
  })

  it('takes values from the person, then the printer, then the model, then a default', () => {
    set({ plate: [entry('a', [1, 2, 3], ['#111111', '#222222'])], printerSlots: [{ id: 'A1', material: 'PETG', color: '#ff0000' }] })
    let r = resolveSlots(get())
    expect(r.map((x) => x.source)).toEqual(['printer', 'model', 'default'])
    expect(r[0]).toMatchObject({ type: 'PETG', color: '#ff0000', label: 'A1' })
    setSlot(1, { color: '#00ff00' })
    r = resolveSlots(get())
    expect(r[0]).toMatchObject({ source: 'user', color: '#00ff00', type: 'PETG' })
    resetSlots(1)
    expect(resolveSlots(get())[0]!.source).toBe('printer')
  })

  it('grows with the highest slot a part or the person uses, up to 16', () => {
    expect(resolveSlots(get())).toHaveLength(1)
    set({ plate: [entry('a', [4])] })
    expect(resolveSlots(get())).toHaveLength(4)
    setSlot(6, {})
    expect(resolveSlots(get())).toHaveLength(6)
    setSlot(16, {})
    setSlot(40, {})
    expect(resolveSlots(get())).toHaveLength(16)
  })

  it('marks slots used by parts on any plate', () => {
    set({ plate: [entry('a', [1])], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }, { id: 'p2', name: 'Plate 2', objects: [entry('b', [3])], settings: { sequence: 'by-layer' } }] })
    expect(resolveSlots(get()).map((x) => x.used)).toEqual([true, false, true])
  })

  it('sends filament keys only for multi-color plates', () => {
    set({ plate: [entry('a', [1])] })
    expect(slotConfig(get())).toEqual({})
    set({ plate: [entry('a', [1, 2])] })
    setSlot(1, { color: '#ffffff', type: 'PLA', brand: 'Bambu Lab' })
    setSlot(2, { color: '#000000', type: 'PETG' })
    const c = slotConfig(get())
    expect(c['filament_colour']).toEqual(['#ffffff', '#000000'])
    expect(c['filament_type']).toEqual(['PLA', 'PETG'])
    expect(c['filament_vendor']).toEqual(['Bambu Lab', '(Undefined)'])
    expect(c['flush_volumes_matrix']).toHaveLength(4)
    setFlushManual('1>2', 640)
    expect((slotConfig(get())['flush_volumes_matrix'] as number[])[1]).toBe(640)
  })
})

describe('model colors per slot', () => {
  // A project's filament_colour, by slot, and its parts' colors as addProject stores them: one per part, by the part's slot.
  const FILE = ['#ff0000', '#00ff00', '#0000ff', '#ffff00']
  const perPart = (slots: number[]) => slots.map((n) => FILE[n - 1]!)

  it('reads the file colors by slot, not part by part', () => {
    const slots = [1, 1, 1, 2, 3, 4]
    set({ plate: [entry('a', slots, perPart(slots))], fileSlotColors: [...FILE] })
    expect(resolveSlots(get()).map((x) => x.color)).toEqual(FILE)
    expect(resolveSlots(get()).map((x) => x.source)).toEqual(['model', 'model', 'model', 'model'])
  })

  it('maps per-part colors to their slots when the file names none', () => {
    const slots = [1, 1, 1, 2, 3, 4]
    set({ plate: [entry('a', slots, perPart(slots))] })
    expect(resolveSlots(get()).map((x) => x.color)).toEqual(FILE)
  })

  it('gives a slot only another plate uses its file color, not the default', () => {
    // Two plates, as a project like tangela.3mf has them: slot 4 is used on the second plate only.
    set({
      plate: [entry('a', [1, 2, 3], perPart([1, 2, 3]))],
      plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }, { id: 'p2', name: 'Plate 2', objects: [entry('b', [4], perPart([4]))], settings: { sequence: 'by-layer' } }],
      fileSlotColors: [...FILE],
    })
    const four = resolveSlots(get())[3]!
    expect(four.color).toBe('#ffff00')
    expect(four.color).not.toBe('#50fa7b')
  })

  it('sends the file colors and their flush matrix to the engine', () => {
    const slots = [1, 1, 1, 2, 3, 4]
    set({ plate: [entry('a', slots, perPart(slots))], fileSlotColors: [...FILE] })
    const c = slotConfig(get())
    expect(c['filament_colour']).toEqual(FILE)
    const plan = flushPlan(get(), 4)
    expect(c['flush_volumes_matrix']).toEqual(plan.nozzles.flatMap((z) => flushValues(FILE, get().flush, z.mins, z.dataset)))
  })
})

describe('slot finishes', () => {
  it('shine as the filament named: silk, matte, PETG glossy, else satin', () => {
    expect(slotFinish({ type: 'PLA', brand: 'Bambu Lab', family: 'Bambu PLA Silk+' })).toBe('silk')
    expect(slotFinish({ type: 'PLA', brand: 'Bambu Lab', family: 'Bambu PLA Matte' })).toBe('matte')
    expect(slotFinish({ type: 'PETG', brand: '' })).toBe('glossy')
    expect(slotFinish({ type: 'PLA', brand: 'Generic' })).toBe('satin')
    expect(slotFinish({ type: 'PLA', brand: 'Mattes and Co' })).toBe('satin')
  })
})

describe('color swap per plate', () => {
  it('swaps two slots on one plate and undoes by swapping back', () => {
    const o = entry('a', [1, 2, 3])
    set({ plate: [o] })
    swapPlateSlots('plate-1', 1, 2)
    const meta = () => get().plates[0]!
    expect(meta().settings.slotMap).toEqual({ 1: 2, 2: 1 })
    expect(slotOverridesFor(meta(), o)).toEqual({ p0: 2, p1: 1 })
    swapPlateSlots('plate-1', 1, 2)
    expect(meta().settings.slotMap).toBeUndefined()
    expect(slotOverridesFor(meta(), o)).toBeUndefined()
  })

  it('composes swaps', () => {
    set({ plate: [entry('a', [1, 2, 3])] })
    swapPlateSlots('plate-1', 1, 2)
    swapPlateSlots('plate-1', 2, 3)
    expect(get().plates[0]!.settings.slotMap).toEqual({ 1: 3, 2: 1, 3: 2 })
  })

  it('leaves other plates alone', () => {
    set({ plates: [...get().plates, { id: 'p2', name: 'Plate 2', objects: [], settings: { sequence: 'by-layer' } }], plate: [entry('a', [1, 2])] })
    swapPlateSlots('p2', 1, 2)
    expect(get().plates[0]!.settings.slotMap).toBeUndefined()
    expect(appStore.getState().plates[1]!.settings.slotMap).toEqual({ 1: 2, 2: 1 })
  })
})

describe('measured pair on a P1S', () => {
  it('black to dark gray is 236 plus the printer minimum of 63', () => {
    expect(flushMatrix(['#000000', '#545454'], undefined, 63, 0)[0]![1]).toBe(299)
  })
})

describe('flush per nozzle', () => {
  const dual = { nozzle_diameter: [0.4, 0.4], nozzle_volume: [107, 140], nozzle_flush_dataset: [1, 2], enable_long_retraction_when_cut: 0 }
  it('reads each nozzle own volume and data set', () => {
    expect(extruderCount(dual)).toBe(2)
    expect(flushInputs(dual, 2, 0).printer).toMatchObject({ nozzleVolume: 107, dataset: 1 })
    expect(flushInputs(dual, 2, 1).printer).toMatchObject({ nozzleVolume: 140, dataset: 2 })
    expect(extruderCount({ nozzle_diameter: [0.4] })).toBe(1)
  })
  it('gives the two data sets different matrices', () => {
    const colors = ['#C12E1F', '#00AE42']
    expect(flushMatrix(colors, undefined, 0, 1)).not.toEqual(flushMatrix(colors, undefined, 0, 2))
  })
  it('reads an H2C, whose lists run per extruder variant, by its two extruders', () => {
    // Left: standard, high flow, E3D high flow; right: standard, high flow (`printer_extruder_id` 1, 1, 1, 2, 2).
    const h2c = {
      nozzle_diameter: [0.4, 0.4],
      printer_extruder_id: [1, 1, 1, 2, 2],
      printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive E3D High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
      nozzle_volume: [130, 133, 133, 145, 148],
      nozzle_flush_dataset: [1, 2, 2, 1, 2],
    }
    expect(extruderCount(h2c)).toBe(2)
    expect([variantIndex(h2c, 0), variantIndex(h2c, 1)]).toEqual([0, 3])
    expect(variantIndex({ ...h2c, nozzle_volume_type: ['Standard', 'High Flow'] }, 1)).toBe(4)
    expect(variantIndex(dual, 1)).toBe(1)
  })
})
