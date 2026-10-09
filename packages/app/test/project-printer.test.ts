// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project opens as its own printer: a P1S 0.2 project on an empty plate switches to our P1S 0.2
// profile with no question, takes the file's whole process and what it changed from its other presets, and slices
// with its own machine G-code. Switching to another printer takes that printer's G-code and leaves the settings made for the 0.2 nozzle.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, PrinterInfo, SettingValue, SliceRequest } from '@slicerx/contracts'
import { resolveConfig } from '../src/adapters/config'
import { readProject } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { zip } from '../src/export/zip'
import { clearProject } from '../src/project/new'
import { answerOpenProject } from '../src/project/open-ask'
import { carryOver, changedKeys, matchProjectPrinter, PROJECT_PRINTER_ID, startProjectPrinterSync } from '../src/project/project-printer'
import { markClean } from '../src/project/unsaved'
import { slotConfig } from '../src/filament/slots'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })

/** A 20 mm cube at the middle of a P1S bed. */
const MODEL = (() => {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="Cube" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 118 118 0"/></build></model>`
})()

const START = 'G28\nM290 Z0.02 ; baby step\nM500\nG1 Z5 F3000\n'

/** The settings of a Bambu Studio P1S 0.2 project, as Bambu Studio writes them. */
const P1S: Record<string, unknown> = {
  printer_settings_id: 'Bambu Lab P1S 0.2 nozzle',
  printer_model: 'Bambu Lab P1S',
  printer_variant: '0.2',
  nozzle_diameter: ['0.2'],
  print_settings_id: '0.06mm Standard @BBL X1C 0.2 nozzle',
  layer_height: '0.08',
  line_width: '0.25',
  wall_loops: '3',
  sparse_infill_density: '35%',
  different_settings_to_system: ['layer_height;wall_loops;line_width', '', ''],
  machine_start_gcode: START,
}

const RANGES = `<?xml version="1.0" encoding="utf-8"?>
<objects>
 <object id="1">
  <range min_z="0" max_z="1.2">
   <option opt_key="layer_height">0.06</option>
   <option opt_key="wall_loops">4</option>
   <option opt_key="sparse_infill_density">30%</option>
  </range>
  <range min_z="1.2" max_z="4">
   <option opt_key="layer_height">0.14</option>
  </range>
 </object>
</objects>`

function project(settings: Record<string, unknown> = P1S, ranges?: string): ArrayBuffer {
  const bytes = zip([
    { name: '3D/3dmodel.model', data: MODEL },
    { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) },
    ...(ranges ? [{ name: 'Metadata/layer_config_ranges.xml', data: ranges }] : []),
  ])
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** A host whose slice records the request and then stops, with `printers` in its printer list. */
function capture(printers: PrinterInfo[] = []): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, printers: { list: async () => printers }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async (name: string) => handle(name) } } as unknown as Host
  return { host, requests }
}

const BAY_2: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1 }

const resolved = (): Record<string, SettingValue> => resolveConfig(get().easy, get().overrides) as Record<string, SettingValue>
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
}

const A1_MINI = { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }

beforeEach(async () => {
  set((s) => ({ plate: [], plates: s.plates.map((p) => ({ ...p, objects: [] })), overrides: {}, vouchedGcode: {}, projectGcode: null, projectSettings: null, projectPrinter: null, projectOpenAsk: null, printerId: A1_MINI.id, printerModel: A1_MINI, printerNozzles: {}, nozzleReported: {}, resume: null, calibration: {}, layerMarks: {}, slice: { status: 'idle' }, toast: null, goal: 'standard' }))
  await profileReady()
  startProjectPrinterSync()
  markClean()
})

describe('matching the printer a project was made for', () => {
  it('by its printer preset name, nozzle variants included', () => {
    expect(matchProjectPrinter(P1S)).toMatchObject({ kind: 'match', profileId: 'bambu-p1s', model: 'P1S', nozzle: 0.2 })
    expect(matchProjectPrinter({ printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle' })).toMatchObject({ kind: 'match', profileId: 'bambu-a1-mini', nozzle: 0.4 })
  })

  it('by model and nozzle when the preset is the person\'s own', () => {
    expect(matchProjectPrinter({ printer_settings_id: 'My P1S', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.6'] })).toMatchObject({ kind: 'match', profileId: 'bambu-p1s', nozzle: 0.6 })
  })

  it('takes the default nozzle when there is no such variant, and says which was asked', () => {
    expect(matchProjectPrinter({ printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.3'] })).toMatchObject({ kind: 'match', profileId: 'bambu-p1s', nozzle: 0.4, asked: 0.3 })
  })

  it('names a printer it has no profile for, and gives null when the file names none', () => {
    expect(matchProjectPrinter({ printer_settings_id: 'Acme Printer 9000 0.4 nozzle', printer_model: 'Acme Printer 9000', nozzle_diameter: ['0.4'] })).toEqual({ kind: 'unknown', name: 'Acme Printer 9000 0.4 nozzle', nozzle: 0.4 })
    expect(matchProjectPrinter({ layer_height: '0.2' })).toBeNull()
  })
})

// The settings of three real projects, cut down to what the checks below read (values as the files have them).
/** Bambu Studio 2.7, a P1S 0.4 project on a process made from "0.12mm Fine", four Bambu PLA Matte filaments. */
const FINE_P1S: Record<string, unknown> = {
  printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', printer_variant: '0.4', nozzle_diameter: ['0.4'],
  print_settings_id: 'N3D - AMS', inherits_group: ['0.12mm Fine @BBL X1C', '', '', '', '', ''],
  different_settings_to_system: ['outer_wall_speed;overhang_1_4_speed;sparse_infill_density;support_top_z_distance;top_shell_layers;wall_loops', '', '', '', '', ''],
  layer_height: '0.12', initial_layer_print_height: '0.2', top_shell_layers: '3', bottom_shell_layers: '5', support_top_z_distance: '0.2', sparse_infill_density: '10%', wall_loops: '3',
  outer_wall_speed: ['50', '200'], inner_wall_speed: ['350', '350'], overhang_1_4_speed: ['50', '60'], default_acceleration: ['10000', '10000'], outer_wall_acceleration: ['5000', '5000'],
  print_extruder_id: ['1', '1'], print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'], extruder_type: ['Direct Drive'], nozzle_volume_type: ['Standard'],
  filament_settings_id: ['Bambu PLA Matte @BBL P1S 0.4 nozzle', 'Bambu PLA Matte @BBL P1S 0.4 nozzle', 'Bambu PLA Matte @BBL P1S 0.4 nozzle', 'Bambu PLA Matte @BBL P1S 0.4 nozzle'],
  filament_type: ['PLA', 'PLA', 'PLA', 'PLA'], filament_colour: ['#000000', '#0078BF', '#DE4343', '#FFFFFF'],
  filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
  filament_max_volumetric_speed: ['22', '29', '22', '29', '22', '29', '22', '29'], filament_density: ['1.32', '1.32', '1.32', '1.32'], nozzle_temperature: ['220', '220', '220', '220', '220', '220', '220', '220'], fan_max_speed: ['100', '100', '100', '100'],
}

/** Bambu Studio 2.7, an H2D project on the stock 0.20mm Standard process, two Generic PLA and two Bambu PLA Basic filaments. */
const H2D_GENERIC: Record<string, unknown> = {
  printer_settings_id: 'Bambu Lab H2D 0.4 nozzle', printer_model: 'Bambu Lab H2D', printer_variant: '0.4', nozzle_diameter: ['0.4', '0.4'],
  print_settings_id: '0.20mm Standard @BBL H2D', different_settings_to_system: ['sparse_infill_pattern;support_type', '', '', '', '', ''],
  layer_height: '0.2', initial_layer_print_height: '0.2', top_shell_layers: '5', bottom_shell_layers: '3', wall_loops: '2', sparse_infill_density: '15%',
  inner_wall_speed: ['300', '600', '600', '300', '600', '600', '600'], outer_wall_speed: ['200', '500', '500', '200', '500', '500', '500'], default_acceleration: ['8000', '8000', '8000', '8000', '8000', '8000', '8000'],
  print_extruder_id: ['1', '1', '1', '2', '2', '2', '2'],
  print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive E3D High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow', 'Direct Drive E3D High Flow'],
  extruder_type: ['Direct Drive', 'Direct Drive'], nozzle_volume_type: ['Standard', 'Standard'],
  filament_settings_id: ['Generic PLA @BBL H2D', 'Generic PLA @BBL H2D', 'Bambu PLA Basic @BBL H2D', 'Bambu PLA Basic @BBL H2D'], filament_type: ['PLA', 'PLA', 'PLA', 'PLA'], filament_colour: ['#FFFFFF', '#000000', '#8E9089', '#FF6A13'],
  filament_extruder_variant: Array.from({ length: 4 }, () => ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive E3D High Flow']).flat(),
  filament_max_volumetric_speed: ['12', '12', '12', '12', '12', '12', '25', '40', '40', '25', '40', '40'], fan_max_speed: ['100', '100', '80', '80'], filament_density: ['1.24', '1.24', '1.26', '1.26'],
}

/** A hand-made project for a printer we have no profile for. */
const HAND_MADE: Record<string, unknown> = {
  printer_settings_id: 'bench machine', printer_model: '', nozzle_diameter: ['0.4'], print_settings_id: 'bench process',
  inherits_group: ['0.20mm Standard @BBL X1C', 'Bambu PLA Basic @BBL P1S', 'Bambu Lab P1S 0.4 nozzle'], different_settings_to_system: ['', '', ''],
  layer_height: '0.2', default_acceleration: ['500'], outer_wall_speed: ['60'], wall_loops: '2', top_shell_layers: '5',
  print_extruder_id: ['1'], print_extruder_variant: ['Direct Drive Standard'], filament_extruder_variant: ['Direct Drive Standard'], extruder_type: ['Direct Drive'], nozzle_volume_type: ['Standard'],
  filament_settings_id: ['bench filament'], filament_type: ['PLA'], filament_colour: ['#00AE42'], filament_max_volumetric_speed: ['2'], nozzle_temperature: ['200'],
}

describe('a project opens with the process and filaments it was made with', () => {
  it('a P1S project on a "0.12mm Fine" process: the whole process and filaments, the standard hotend values', async () => {
    const { host } = capture()
    await openModelBytes(host, 'fine.3mf', project(FINE_P1S))
    expect(get().printerId).toBe(PROJECT_PRINTER_ID)
    const cfg = resolved()
    expect(cfg['layer_height']).toBe(0.12)
    expect(cfg['bottom_shell_layers']).toBe(5)
    expect(cfg['top_shell_layers']).toBe(3)
    expect(cfg['support_top_z_distance']).toBe(0.2)
    expect(cfg['default_acceleration']).toEqual([10000])
    expect(cfg['outer_wall_acceleration']).toEqual([5000])
    // [standard hotend, high flow]: the P1S has the standard one.
    expect(cfg['outer_wall_speed']).toEqual([50])
    expect(cfg['inner_wall_speed']).toEqual([350])
    expect(cfg['overhang_1_4_speed']).toEqual(['50'])
    // One value per filament, the standard hotend's: Bambu PLA Matte, not our default PLA.
    const slice = { ...cfg, ...slotConfig(get()) }
    expect(slice['filament_max_volumetric_speed']).toEqual([22, 22, 22, 22])
    expect(slice['filament_density']).toEqual([1.32, 1.32, 1.32, 1.32])
    expect(slice['nozzle_temperature']).toEqual([220, 220, 220, 220])
  })

  it('an H2D project: one value per extruder and one per filament, from each standard hotend', async () => {
    const { host } = capture()
    await openModelBytes(host, 'generic.3mf', project(H2D_GENERIC))
    expect(get().profile?.printerId).toBe('bambu-h2d')
    const cfg = resolved()
    expect(cfg['inner_wall_speed']).toEqual([300, 300])
    expect(cfg['outer_wall_speed']).toEqual([200, 200])
    expect(cfg['default_acceleration']).toEqual([8000, 8000])
    expect(cfg['sparse_infill_density']).toBe(15)
    const slice = { ...cfg, ...slotConfig(get()) }
    expect(slice['filament_max_volumetric_speed']).toEqual([12, 12, 25, 25])
    expect(slice['fan_max_speed']).toEqual([100, 100, 80, 80])
    expect(slice['filament_density']).toEqual([1.24, 1.24, 1.26, 1.26])
  })

  it("keeps SlicerX's aegis walls over the project's inherited classic walls, and says so", async () => {
    const { host } = capture()
    await openModelBytes(host, 'fine.3mf', project({ ...FINE_P1S, wall_generator: 'classic', precise_outer_wall: '0' }))
    const cfg = resolved()
    expect(cfg['wall_generator']).toBe('aegis')
    expect(get().toast?.text).toContain("Kept SlicerX's aegis walls; the project used Bambu's default.")
    expect(cfg['layer_height']).toBe(0.12)
  })

  it('takes the walls the person chose in the project, with no note', async () => {
    const { host } = capture()
    const listed = [`${(FINE_P1S['different_settings_to_system'] as string[])[0]};wall_generator`, '', '', '', '', '']
    await openModelBytes(host, 'fine.3mf', project({ ...FINE_P1S, wall_generator: 'classic', different_settings_to_system: listed }))
    expect(resolved()['wall_generator']).toBe('classic')
    expect(get().toast?.text).not.toContain('Kept SlicerX')
  })

  // A saved quality tile and saved Simple-mode settings apply to plain models and new plates, never over a project's
  // own process: opening it shows Custom, and the slice takes the project's layer height.
  for (const auto of [true, false]) {
    it(`a saved goal and Simple-mode settings leave a project's process alone (${auto ? 'auto' : 'manual'} slice)`, async () => {
      const before = get()
      const kept = { easy: before.easy, easyTouched: before.easyTouched, autoSlice: before.autoSlice, settingsMode: before.settingsMode, handPrinters: before.handPrinters }
      const p1s = { id: 'local-bambu-p1s', name: 'P1S', vendor: 'Bambu Lab', model: 'P1S', profileId: 'bambu-p1s', nozzleCount: 1 }
      try {
        set((s) => ({ handPrinters: [p1s], printerId: p1s.id, printerModel: { id: p1s.id, vendor: p1s.vendor, model: p1s.model }, printerNozzles: { ...s.printerNozzles, [p1s.id]: 0.4 } }))
        await profileReady()
        set({ goal: 'standard', autoSlice: auto, settingsMode: 'simple', easy: { detail: 40, strength: 20, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: false }, easyTouched: ['varyLayerHeight'] })
        const { host, requests } = capture([{ id: p1s.id, name: p1s.name, vendor: p1s.vendor, model: p1s.model, plugin: 'export', nozzleCount: 1 }])
        await openModelBytes(host, 'tangela.3mf', project(FINE_P1S))
        expect(get().toast?.text).toContain("Opened on P1S, a P1S 0.4 mm like the project's.")
        expect(get().goal).toBe('custom')
        await slicePlate(host, auto ? { auto: true } : {}).catch(() => undefined)
        expect(requests.at(-1)?.config['layer_height']).toBe(0.12)
      } finally {
        set(kept)
      }
    })
  }

  it('a project for a printer we have no profile for keeps its values on the current printer', async () => {
    const { host } = capture()
    await openModelBytes(host, 'bench.3mf', project(HAND_MADE))
    expect(get().printerId).toBe(A1_MINI.id)
    const cfg = resolved()
    expect(cfg['default_acceleration']).toEqual([500])
    expect(cfg['outer_wall_speed']).toEqual([60])
    const slice = { ...cfg, ...slotConfig(get()) }
    expect(slice['filament_max_volumetric_speed']).toEqual([2])
    expect(slice['nozzle_temperature']).toEqual([200])
  })
})

describe('switch rules', () => {
  it('reads the keys the file changed from its presets', () => {
    expect([...changedKeys(P1S)!].sort()).toEqual(['layer_height', 'line_width', 'wall_loops'])
    expect(changedKeys({})).toBeUndefined()
  })

  it('keeps G-code with the project printer, and nozzle settings too when the nozzle differs', () => {
    const o = { layer_height: 0.06, line_width: 0.22, outer_wall_line_width: 0.22, wall_loops: 3, machine_start_gcode: START }
    expect(carryOver(o, ['machine_start_gcode'], false)).toEqual({ kept: { wall_loops: 3 }, parked: { layer_height: 0.06, line_width: 0.22, outer_wall_line_width: 0.22, machine_start_gcode: START }, dropped: ['layer_height', 'line_width', 'outer_wall_line_width'] })
    expect(carryOver(o, ['machine_start_gcode'], true).kept).toEqual({ layer_height: 0.06, line_width: 0.22, outer_wall_line_width: 0.22, wall_loops: 3 })
  })
})

describe('a P1S 0.2 project on an empty plate', () => {
  it("opens as its own printer with no question, and the file's whole process", async () => {
    const { host } = capture()
    await openModelBytes(host, 'pumpkin.3mf', project())
    const s = get()
    expect(s.plate).toHaveLength(1)
    expect(s.printerId).toBe(PROJECT_PRINTER_ID)
    expect(s.projectPrinter).toMatchObject({ model: 'P1S', nozzle: 0.2, source: 'pumpkin.3mf', previousPrinterId: A1_MINI.id })
    expect(s.profile).toMatchObject({ printerId: 'bambu-p1s', nozzle: 0.2 })
    expect(s.projectGcode).toBeNull()
    const cfg = resolved()
    expect(cfg['layer_height']).toBe(0.08)
    expect(String(cfg['line_width'])).toBe('0.25')
    expect(cfg['wall_loops']).toBe(3)
    // Not listed as changed, but part of the process the project was sliced with.
    expect(cfg['sparse_infill_density']).toBe(35)
    expect(cfg['machine_start_gcode']).toBe(START)
    expect(s.toast?.text).toBe('Opened as P1S 0.2 mm from the project.')
    expect(s.toast?.action?.label).toBe('Change printer')
  })

  it("takes the layer height of the project's process preset, which the file does not list as changed", async () => {
    // A Bambu Studio P1S 0.4 project on a user process preset made from "0.12mm Fine": its 0.12 mm layers are the
    // preset's own, so different_settings_to_system lists only the other changes.
    const fine = {
      printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
      printer_model: 'Bambu Lab P1S',
      printer_variant: '0.4',
      nozzle_diameter: ['0.4'],
      print_settings_id: 'N3D - AMS',
      inherits_group: ['0.12mm Fine @BBL X1C', '', ''],
      layer_height: '0.12',
      initial_layer_print_height: '0.2',
      bottom_shell_layers: '5',
      support_top_z_distance: '0.12',
      wall_loops: '4',
      sparse_infill_density: '35%',
      different_settings_to_system: ['wall_loops', '', ''],
    }
    const { host, requests } = capture()
    await openModelBytes(host, 'tangela.3mf', project(fine))
    expect(get().printerId).toBe(PROJECT_PRINTER_ID)
    const cfg = resolved()
    expect(cfg['layer_height']).toBe(0.12)
    expect(cfg['bottom_shell_layers']).toBe(5)
    expect(cfg['support_top_z_distance']).toBe(0.12)
    expect(cfg['wall_loops']).toBe(4)
    expect(cfg['sparse_infill_density']).toBe(35)
    await slicePlate(host, { auto: true })
    expect((requests[0]!.config as Record<string, SettingValue>)['layer_height']).toBe(0.12)
  })

  it('slices with the project G-code, trusted on its own printer', async () => {
    const { host, requests } = capture()
    await openModelBytes(host, 'pumpkin.3mf', project())
    await slicePlate(host, { auto: true })
    expect(requests).toHaveLength(1)
    expect((requests[0]!.config as Record<string, SettingValue>)['machine_start_gcode']).toBe(START)
    expect(requests[0]!.options?.trustedGcode).toBe(true)
  })

  it('moving to an A1 mini takes its G-code and leaves the 0.2 mm settings, and coming back restores them', async () => {
    const { host, requests } = capture()
    await openModelBytes(host, 'pumpkin.3mf', project())
    set({ printerId: A1_MINI.id, printerModel: A1_MINI })
    await profileReady()
    expect(get().profile?.printerId).toBe('bambu-a1-mini')
    // The A1 mini's own start G-code, none of the project's.
    const own = resolveConfig(get().easy, {}) as Record<string, SettingValue>
    const cfg = resolved()
    expect(cfg['machine_start_gcode']).toBe(own['machine_start_gcode'])
    expect(String(cfg['machine_start_gcode'])).not.toContain('M290 Z0.02 ; baby step')
    expect(String(cfg['machine_start_gcode'])).not.toMatch(/^M500/m)
    expect(cfg['layer_height']).toBe(own['layer_height'])
    expect(cfg['wall_loops']).toBe(3)
    expect(get().toast?.text).toBe("Slicing for the A1 mini with its own G-code. Not carried over, made for the project's 0.2 mm nozzle: layer height, default line width.")
    await slicePlate(host, { auto: true })
    expect((requests[0]!.config as Record<string, SettingValue>)['machine_start_gcode']).toBe(own['machine_start_gcode'])
    set({ printerId: PROJECT_PRINTER_ID, printerModel: { id: PROJECT_PRINTER_ID, vendor: 'Bambu Lab', model: 'P1S' } })
    await profileReady()
    expect(resolved()['layer_height']).toBe(0.08)
    expect(resolved()['machine_start_gcode']).toBe(START)
  })

  it('a printer with the same nozzle keeps the layer height, and warns when it reports another nozzle', async () => {
    const { host } = capture()
    await openModelBytes(host, 'pumpkin.3mf', project())
    set((s) => ({ printerNozzles: { ...s.printerNozzles, 'my-p1s': 0.2 }, printerId: 'my-p1s', printerModel: { id: 'my-p1s', vendor: 'Bambu Lab', model: 'P1S' } }))
    expect(get().overrides['layer_height']).toBe(0.08)
    expect(get().overrides).not.toHaveProperty('machine_start_gcode')
    set({ printerId: PROJECT_PRINTER_ID, printerModel: { id: PROJECT_PRINTER_ID, vendor: 'Bambu Lab', model: 'P1S' } })
    set((s) => ({ nozzleReported: { ...s.nozzleReported, 'other-p1s': 0.4 }, printerId: 'other-p1s', printerModel: { id: 'other-p1s', vendor: 'Bambu Lab', model: 'P1S' } }))
    expect(get().overrides).not.toHaveProperty('layer_height')
    expect(get().toast).toMatchObject({ tone: 'warn' })
    expect(get().toast?.text).toMatch(/Your P1S reports a 0.4 mm nozzle; the project is set up for 0.2 mm\.$/)
  })

  it('picks the person\'s own P1S with a 0.2 mm nozzle over the project printer, with its own G-code', async () => {
    set((s) => ({ nozzleReported: { ...s.nozzleReported, [BAY_2.id]: 0.2 } }))
    const { host } = capture([BAY_2])
    await openModelBytes(host, 'pumpkin.3mf', project())
    expect(get().printerId).toBe(BAY_2.id)
    expect(get().projectPrinter).toBeNull()
    expect(get().profile).toMatchObject({ printerId: 'bambu-p1s', nozzle: 0.2 })
    expect(get().overrides['layer_height']).toBe(0.08)
    expect(get().overrides).not.toHaveProperty('machine_start_gcode')
    expect(get().toast?.text).toBe("Opened on Bay 2, a P1S 0.2 mm like the project's.")
  })

  it('a P1S with another nozzle is not picked', async () => {
    set((s) => ({ nozzleReported: { ...s.nozzleReported, [BAY_2.id]: 0.4 } }))
    const { host } = capture([BAY_2])
    await openModelBytes(host, 'pumpkin.3mf', project())
    expect(get().printerId).toBe(PROJECT_PRINTER_ID)
  })

  it('a new project drops the project printer and what it brought', async () => {
    const { host } = capture()
    await openModelBytes(host, 'pumpkin.3mf', project())
    clearProject()
    expect(get().projectPrinter).toBeNull()
    expect(get().printerId).toBe(A1_MINI.id)
    expect(get().overrides).not.toHaveProperty('machine_start_gcode')
    expect(get().overrides).not.toHaveProperty('layer_height')
    expect(get().vouchedGcode).toEqual({})
  })

  it('a printer SlicerX has no profile for keeps the current one, without its G-code or nozzle settings', async () => {
    const { host } = capture()
    await openModelBytes(host, 'acme.3mf', project({ printer_settings_id: 'Acme Printer 9000 0.2 nozzle', printer_model: 'Acme Printer 9000', nozzle_diameter: ['0.2'], layer_height: '0.08', wall_loops: '3', machine_start_gcode: START }))
    expect(get().printerId).toBe(A1_MINI.id)
    expect(get().projectPrinter).toBeNull()
    expect(get().overrides).toMatchObject({ wall_loops: 3 })
    expect(get().overrides).not.toHaveProperty('layer_height')
    expect(get().overrides).not.toHaveProperty('machine_start_gcode')
    expect(get().toast?.text).toBe('acme.3mf is for a Acme Printer 9000 0.2 nozzle, which SlicerX has no profile for, so it opened on the A1 mini. Left out, made for a 0.2 mm nozzle: layer height.')
  })
})

describe('settings by height', () => {
  it('range keys go to the slice by object, layer heights as layer tops, the rest is named', async () => {
    const { host, requests } = capture()
    await openModelBytes(host, 'pumpkin.3mf', project(P1S, RANGES))
    const e = get().plate[0]!
    expect(e.layerRanges).toEqual([
      { minZ: 0, maxZ: 1.2, settings: { layer_height: 0.06, wall_loops: 4 } },
      { minZ: 1.2, maxZ: 4, settings: { layer_height: 0.14 } },
    ])
    expect(get().toast?.text).toBe('Opened as P1S 0.2 mm from the project. Not imported from its height ranges: infill density.')
    await slicePlate(host, { auto: true })
    const o = requests[0]!.options!
    expect(o.heightRanges).toEqual([{ zFromMm: 0, zToMm: 1.2, settings: { wall_loops: 4 }, objects: [e.id] }])
    const tops = o.layerTopsMm!
    const steps = tops.slice(1).map((t, i) => Math.round((t - tops[i]!) * 1000) / 1000)
    const at = (z: number) => tops.findIndex((t) => t > z)
    expect(new Set(steps.slice(0, at(1.2) - 1))).toEqual(new Set([0.06]))
    expect(steps[at(2) - 1]).toBe(0.14)
    expect(steps[at(10) - 1]).toBe(0.08)
    expect(tops[tops.length - 1]).toBe(20)
  })
})

describe('layer heights by height that differ between objects', () => {
  it('are named as not imported yet', async () => {
    const mesh = MODEL.slice(MODEL.indexOf('<mesh>'), MODEL.indexOf('</mesh>') + '</mesh>'.length)
    const two = MODEL.replace('</resources>', `<object id="2" name="Cube 2" type="model">${mesh}</object></resources>`).replace('</build>', '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 60 60 0"/></build>')
    const ranges = RANGES.replace('</objects>', ' <object id="2">\n  <range min_z="0" max_z="2">\n   <option opt_key="layer_height">0.12</option>\n  </range>\n </object>\n</objects>')
    const bytes = zip([
      { name: '3D/3dmodel.model', data: two },
      { name: 'Metadata/project_settings.config', data: JSON.stringify(P1S) },
      { name: 'Metadata/layer_config_ranges.xml', data: ranges },
    ])
    const { host } = capture()
    await openModelBytes(host, 'two.3mf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    expect(get().plate).toHaveLength(2)
    expect(get().toast?.text).toContain('Per-object layer heights are not imported yet')
  })
})

describe('settings by height in a Bambu Studio file', () => {
  it('number objects by build order, not by their ids', async () => {
    // Bambu Studio keeps the object as id 7 with its parts in components, and calls it object 1 in the ranges.
    const seven = MODEL.replace('<object id="1"', '<object id="7"').replace('objectid="1"', 'objectid="7"')
    const bytes = zip([
      { name: '3D/3dmodel.model', data: seven },
      { name: 'Metadata/project_settings.config', data: JSON.stringify(P1S) },
      { name: 'Metadata/layer_config_ranges.xml', data: RANGES },
    ])
    const { host } = capture()
    await openModelBytes(host, 'seven.3mf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    expect(get().plate[0]!.layerRanges).toHaveLength(2)
  })
})

describe('settings by height in a saved project', () => {
  it('are written back and read again', async () => {
    const { host } = capture()
    await openModelBytes(host, 'pumpkin.3mf', project(P1S, RANGES))
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: get().plate, settings: {} }], bed: get().bed, settings: {} })
    const back = await readProject(bytes, get().bed)
    expect(back.plates[0]!.objects[0]!.layerRanges).toEqual(get().plate[0]!.layerRanges)
  })
})

describe('a project added to a plate with objects', () => {
  async function addOnto(choice: 'project' | 'geometry'): Promise<void> {
    const { host } = capture()
    await openModelBytes(host, 'pumpkin.3mf', project())
    clearProject()
    await openModelBytes(host, 'first.3mf', project({ layer_height: '0.2' }))
    markClean()
    const before = get().overrides
    const opening = openModelBytes(host, 'pumpkin.3mf', project())
    await until(() => get().projectOpenAsk !== null)
    expect(get().projectOpenAsk).toEqual({ source: 'pumpkin.3mf' })
    answerOpenProject(choice)
    await opening
    if (choice === 'geometry') {
      expect(get().plate).toHaveLength(2)
      expect(get().printerId).toBe(A1_MINI.id)
      expect(get().overrides).toEqual(before)
    }
  }

  it('asks, and geometry only adds the objects with no settings', async () => {
    await addOnto('geometry')
  })

  it('asks, and open as project replaces the plate on the project printer', async () => {
    await addOnto('project')
    expect(get().plate).toHaveLength(1)
    expect(get().printerId).toBe(PROJECT_PRINTER_ID)
    expect(resolved()['layer_height']).toBe(0.08)
  })
})
