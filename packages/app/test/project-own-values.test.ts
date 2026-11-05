// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project opened on a fresh plate keeps the values it holds after the plate moves to the goal nearest its layer
// height: a P1S project on 0.12 mm layers whose 0.2 mm support gaps and 50 mm/s overhang speed are inherited, equal to
// Standard's and not listed as changed, and another slicer's project with its own 0.2 mm gaps, each on the A1. The
// Fine goal's 0.12 mm gaps used to replace them. A value equal to the layer the plate lands on is let go: a later goal
// pick, filament change or Switch to moves it, New project leaves a later edit to it alone, and a person's own
// override the open left as it was comes back on New project.
import { describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue } from '@slicerx/contracts'
import { importFlat } from '@slicerx/settings'

const { openModelBytes } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { get, set } = await import('../src/state/store')
const { plateSliceConfig } = await import('../src/state/slice-plate')
const { activeMeta } = await import('../src/plate/plates')
const { zip } = await import('../src/export/zip')
const { goalEasy, goalKeys, resolveConfig } = await import('../src/adapters/config')
const { setSlot } = await import('../src/filament/slots')
const { clearProject } = await import('../src/project/new')
const { sx3mfBytes } = await import('../src/export/actions')
const { allPlates } = await import('../src/plate/plates')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ ...handle(name), parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) } } as unknown as Host

const cube = (() => {
  const v = [[0, 0, 0], [12, 0, 0], [12, 12, 0], [0, 12, 0], [0, 0, 12], [12, 0, 12], [12, 12, 12], [0, 12, 12]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
})()
const model = (app: string) => `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">${app}</metadata><resources><object id="1" type="model">${cube}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 110 110 0"/></build></model>`
const bambuFile = (settings: Record<string, unknown>) => zip([{ name: '3D/3dmodel.model', data: model('BambuStudio-02.08.04.61') }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }])
const prusaFile = (lines: string[]) => zip([{ name: '3D/3dmodel.model', data: model('PrusaSlicer-2.9.6') }, { name: 'Metadata/Slic3r_PE.config', data: lines.map((l) => `; ${l}`).join('\n') }])

const P1S_ID = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'] }
const inherited = bambuFile({ ...P1S_ID, inherits_group: ['0.20mm Standard @BBL X1C', '', ''], layer_height: '0.12', enable_support: '1', support_top_z_distance: '0.2', support_bottom_z_distance: '0.2', overhang_2_4_speed: '50', different_settings_to_system: ['enable_support;layer_height', '', ''] })
const prusaGaps = ['layer_height = 0.12', 'first_layer_height = 0.2', 'support_material = 1', 'support_material_contact_distance = 0.2', 'support_material_bottom_contact_distance = 0.2']

const A1 = { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' }
const P1S = { id: 'my-p1s', vendor: 'Bambu Lab', model: 'P1S' }
const MK4 = { id: 'my-mk4', vendor: 'Prusa Research', model: 'MK4' }
const MK4S = { id: 'my-mk4s', vendor: 'Prusa Research', model: 'MK4S' }
type Printer = typeof A1 | null

async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
}
const config = (): Record<string, SettingValue> => resolveConfig(get().easy, get().overrides) as unknown as Record<string, SettingValue>
const layer = (): Record<string, SettingValue> => resolveConfig(get().easy, {}) as unknown as Record<string, SettingValue>
const pinnedOf = (keys: readonly string[]): string[] => keys.filter((k) => k in get().overrides)

/** A fresh plate on `printer` (none for the generic bed) with `overrides`, on Standard. */
async function fresh(printer: Printer, overrides: Record<string, SettingValue> = {}): Promise<void> {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], slotSetup: {}, openNote: null, printerId: printer?.id ?? null, printerModel: printer, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', overrides, vouchedGcode: {}, toast: null }))
  startProfileSync()
  startProjectPrinterSync()
  await settled()
}

/** The config the app slices `bytes` with, opened on a fresh plate on `printer`. */
async function openOn(printer: Printer, name: string, bytes: Uint8Array, overrides: Record<string, SettingValue> = {}): Promise<Record<string, unknown>> {
  await fresh(printer, overrides)
  await openModelBytes(host, name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, undefined, { fresh: true })
  await settled()
  const s = get()
  return plateSliceConfig(s, activeMeta(s)) as unknown as Record<string, unknown>
}

/** Our Standard layer's values for `keys` on `printer`. */
async function standardOf(printer: Printer, keys: readonly string[]): Promise<Record<string, SettingValue>> {
  await fresh(printer)
  const cfg = config()
  return Object.fromEntries(keys.map((k) => [k, cfg[k]!]))
}
const raw = (v: SettingValue): string | string[] => (Array.isArray(v) ? v.map(String) : String(v))

/**
 * Picks a goal tile as the Easy panel's pickGoal does (easy-settings.tsx, a component module this test does not load):
 * the goal's own keys dropped from the overrides, then its stock values.
 */
async function pickGoal(goal: 'fine'): Promise<void> {
  const keys = new Set(goalKeys())
  set((s) => ({ overrides: Object.fromEntries(Object.entries(s.overrides).filter(([k]) => !keys.has(k))), easy: { ...s.easy, ...goalEasy(goal) }, goal, goalBase: goal, easyTouched: [] }))
  await settled()
}

describe('a project opened on a fresh plate', () => {
  it('keeps its inherited values on the nearest goal', async () => {
    const cfg = await openOn(A1, 'p1s-gaps.3mf', inherited)
    expect(get().goal).toBe('custom')
    expect(get().goalBase).toBe('fine')
    expect(cfg['layer_height']).toBe(0.12)
    expect(cfg['support_top_z_distance']).toBe(0.2)
    expect(cfg['support_bottom_z_distance']).toBe(0.2)
    expect(cfg['overhang_2_4_speed']).toEqual(importFlat({ overhang_2_4_speed: '50' }).config['overhang_2_4_speed'])
  })

  it("keeps another slicer's project values on the nearest goal", async () => {
    const cfg = await openOn(A1, 'prusa-gaps.3mf', prusaFile(prusaGaps))
    expect(get().goalBase).toBe('fine')
    expect(cfg['layer_height']).toBe(0.12)
    expect(cfg['support_top_z_distance']).toBe(0.2)
    expect(cfg['support_bottom_z_distance']).toBe(0.2)
  })

  it("keeps another slicer's project values when none differs from the plate", async () => {
    // The person's own 0.12 mm layers on Standard: the file changes nothing, and the plate still moves to Fine.
    const cfg = await openOn(A1, 'prusa-same.3mf', prusaFile(['layer_height = 0.12', 'support_material_contact_distance = 0.2', 'support_material_bottom_contact_distance = 0.2']), { layer_height: 0.12 })
    expect(get().goalBase).toBe('fine')
    expect(cfg['support_top_z_distance']).toBe(0.2)
    expect(cfg['support_bottom_z_distance']).toBe(0.2)
  })

  it('keeps its real changes when the plate moves to a printer whose Fine layer differs', async () => {
    // 0.12 mm layers equal the P1S Fine layer, but they are the project's change; the MK4S's Fine is not 0.12 mm.
    await openOn(A1, 'p1s-gaps.3mf', inherited)
    expect(get().overrides['layer_height']).toBe(0.12)
    set({ printerId: MK4S.id, printerModel: MK4S })
    await settled()
    expect(get().profile?.printerId).toBe('prusa-mk4s')
    expect(config()['layer_height']).toBe(0.12)
    expect(config()['support_top_z_distance']).toBe(0.2)
  })

  it('keeps the goal of our own project reopened as it was', async () => {
    await openOn(A1, 'prusa-gaps.3mf', prusaFile(prusaGaps))
    set((s) => ({ overrides: {}, easy: { ...s.easy, ...goalEasy('fine') }, goal: 'fine', goalBase: 'fine', easyTouched: [] }))
    await settled()
    const bytes = await sx3mfBytes(allPlates(get()))
    set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, openNote: null }))
    await openModelBytes(host, 'mine.sx3mf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, undefined, { fresh: true })
    await settled()
    expect(get().goal).toBe('fine')
    expect(Object.keys(get().overrides)).toEqual([])
  })

  it('keeps its values with no printer until one is added', async () => {
    await openOn(null, 'prusa-gaps.3mf', prusaFile(prusaGaps))
    expect(get().overrides['support_top_z_distance']).toBe(0.2)
    set({ printerId: A1.id, printerModel: A1 })
    await settled()
    expect(config()['layer_height']).toBe(0.12)
    expect(config()['support_top_z_distance']).toBe(0.2)
  })
})

const KEYS = ['layer_height', 'support_top_z_distance', 'support_bottom_z_distance', 'overhang_2_4_speed', 'nozzle_temperature', 'hot_plate_temp', 'wall_loops']
async function standardProject(): Promise<Uint8Array> {
  const own = await standardOf(P1S, KEYS)
  return bambuFile({ ...P1S_ID, ...Object.fromEntries(Object.entries(own).map(([k, v]) => [k, raw(v)])), different_settings_to_system: ['', '', ''] })
}

describe("a project's values equal to the layer it lands on", () => {
  it('are let go, and follow a later goal pick', async () => {
    await openOn(A1, 'p1s-standard.3mf', await standardProject())
    expect(pinnedOf(KEYS)).toEqual([])
    await pickGoal('fine')
    for (const k of [...goalKeys(), ...KEYS]) expect(config()[k], k).toEqual(layer()[k])
    expect(config()['layer_height']).toBe(0.12)
    expect(config()['support_top_z_distance']).toBe(0.12)
  })

  it("are let go, and follow a slot's filament change", async () => {
    await openOn(A1, 'p1s-standard.3mf', await standardProject())
    const pla = config()
    setSlot(1, { type: 'PETG', brand: '' })
    await settled()
    expect(pinnedOf(KEYS)).toEqual([])
    expect(config()['nozzle_temperature']).not.toEqual(pla['nozzle_temperature'])
    expect(config()['hot_plate_temp']).not.toEqual(pla['hot_plate_temp'])
    for (const k of KEYS) expect(config()[k], k).toEqual(layer()[k])
  })

  it('leave a later edit to them alone on New project', async () => {
    await openOn(A1, 'p1s-standard.3mf', await standardProject())
    set((s) => ({ overrides: { ...s.overrides, wall_loops: 5 } }))
    clearProject()
    expect(get().overrides['wall_loops']).toBe(5)
  })

  it("leave a person's own override equal to the project's to come back on New project", async () => {
    const file = await standardProject()
    const own = (await standardOf(P1S, ['wall_loops']))['wall_loops']!
    await openOn(A1, 'p1s-standard.3mf', file, { wall_loops: own })
    expect(get().overrides['wall_loops']).toBe(own)
    clearProject()
    expect(get().overrides['wall_loops']).toBe(own)
  })
})

describe("Switch to another slicer's project's printer", () => {
  const SWITCH_KEYS = ['layer_height', 'support_top_z_distance', 'nozzle_temperature']
  /** A project for the MK4 whose values equal our MK4 Standard's, and the person's own wall loops equal to the project's. */
  async function openForMk4(): Promise<SettingValue> {
    const mk4 = await standardOf(MK4, [...SWITCH_KEYS, 'wall_loops'])
    const text = (v: SettingValue) => (Array.isArray(v) ? v.join(',') : String(v))
    const lines = ['printer_model = MK4IS', 'nozzle_diameter = 0.4', `layer_height = ${text(mk4['layer_height']!)}`, `support_material_contact_distance = ${text(mk4['support_top_z_distance']!)}`, `temperature = ${text(mk4['nozzle_temperature']!)}`, `perimeters = ${text(mk4['wall_loops']!)}`]
    await openOn(A1, 'mk4-standard.3mf', prusaFile(lines), { wall_loops: mk4['wall_loops']! })
    expect(get().openNote?.action?.label).toBe('Switch to MK4 0.4 mm')
    get().openNote!.action!.run()
    await until(() => get().openNote?.text.startsWith('Switched') === true)
    await settled()
    return mk4['wall_loops']!
  }

  it('lets go of values equal to its layer, which then follow a goal pick and a filament change', async () => {
    const loops = await openForMk4()
    expect(get().openNote?.text).toBe('Switched to MK4 0.4 mm.')
    expect(pinnedOf(SWITCH_KEYS)).toEqual([])
    expect(get().overrides['wall_loops']).toBe(loops)
    await pickGoal('fine')
    for (const k of SWITCH_KEYS) expect(config()[k], k).toEqual(layer()[k])
    const pla = config()['nozzle_temperature']
    setSlot(1, { type: 'PETG', brand: '' })
    await settled()
    expect(pinnedOf(SWITCH_KEYS)).toEqual([])
    expect(config()['nozzle_temperature']).not.toEqual(pla)
  })

  it("keeps the person's own override and a later edit on New project", async () => {
    const loops = await openForMk4()
    set((s) => ({ overrides: { ...s.overrides, support_top_z_distance: 0.3 } }))
    clearProject()
    expect(get().overrides['wall_loops']).toBe(loops)
    expect(get().overrides['support_top_z_distance']).toBe(0.3)
  })
})
