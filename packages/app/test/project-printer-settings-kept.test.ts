// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project opened on its own printer slices with every printer setting the file holds, listed as changed or not, as
// `sx project-settings` reads the same file: air filtration, fan direction and the silent mode machine limits among
// them, though no machine limit above the printer's. Its machine G-code still goes through the G-code review, and the bed, the nozzle, the clearances, the firmware
// and the printer's name stay the profile's, so no check gets looser. A project for a printer SlicerX has no profile
// for, and the move to another printer, leave the file's printer settings behind as before.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue, SliceRequest } from '@slicerx/contracts'
import { resolveConfig } from '../src/adapters/config'
import { zip } from '../src/export/zip'
import { clearProject } from '../src/project/new'
import { PROJECT_PRINTER_ID, startProjectPrinterSync } from '../src/project/project-printer'
import { markClean } from '../src/project/unsaved'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })

/** A host whose slice records the request and then stops. */
function capture(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, printers: { list: async () => [] }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async (name: string) => handle(name) } } as unknown as Host
  return { host, requests }
}

const MODEL = (() => {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  const object = `<object id="1" name="Box" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
  return `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${object}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 118 118 0"/></build></model>`
})()

const P1S = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'] }

/** The printer settings of the report's file that the P1S profile has otherwise, none of them listed as changed. */
const UNLISTED = {
  support_air_filtration: '0',
  fan_direction: 'left',
  machine_max_speed_x: ['500', '150'],
  machine_max_speed_y: ['500', '150'],
  machine_max_acceleration_z: ['500', '150'],
  extruder_colour: ['#018001'],
  best_object_pos: '0.3x0.7',
}

/** A one-object project with `settings` as its project settings, listing only its layer height as changed. */
function project(settings: Record<string, unknown>): ArrayBuffer {
  const all = { layer_height: '0.2', different_settings_to_system: ['layer_height', '', ''], ...settings }
  const b = zip([{ name: '3D/3dmodel.model', data: MODEL }, { name: 'Metadata/project_settings.config', data: JSON.stringify(all) }])
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** Opens `bytes` the way the app does and returns the config of the slice request it sends. */
async function sliced(bytes: ArrayBuffer): Promise<Record<string, SettingValue>> {
  const { host, requests } = capture()
  await openModelBytes(host, 'kept.3mf', bytes)
  await slicePlate(host, { auto: true }).catch(() => undefined)
  const cfg = requests.at(-1)?.config as Record<string, SettingValue> | undefined
  expect(cfg).toBeDefined()
  return cfg!
}

const resolved = (): Record<string, SettingValue> => resolveConfig(get().easy, get().overrides) as Record<string, SettingValue>
const A1_MINI = { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }

beforeEach(async () => {
  clearProject()
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', slotSetup: {}, openNote: null, projectFlush: null, towerFromProject: false, projectTowers: {}, tower: { auto: true, x: 0, y: 0 }, overrides: {}, vouchedGcode: {}, projectGcode: null, projectSettings: null, projectPrinter: null, projectOpenAsk: null, printerId: A1_MINI.id, printerModel: A1_MINI, printerNozzles: {}, nozzleReported: {}, slice: { status: 'idle' }, toast: null, goal: 'standard' }))
  await profileReady()
  startProjectPrinterSync()
  markClean()
})

describe("a project's printer settings on its own printer", () => {
  it('reach the slice request as the file has them, listed as changed or not', async () => {
    const cfg = await sliced(project({ ...P1S, ...UNLISTED }))
    expect(get().printerId).toBe(PROJECT_PRINTER_ID)
    expect.soft(cfg['support_air_filtration']).toBe(false)
    expect.soft(cfg['fan_direction']).toBe('left')
    // the second entry is the silent mode value, 200 in the P1S profile; a file may lower it
    expect.soft(cfg['machine_max_speed_x']).toEqual([500, 150])
    expect.soft(cfg['machine_max_speed_y']).toEqual([500, 150])
    expect.soft(cfg['machine_max_acceleration_z']).toEqual([500, 150])
    expect.soft(cfg['extruder_colour']).toEqual(['#018001'])
    expect.soft(cfg['best_object_pos']).toEqual([0.3, 0.7])
  })

  it('leave a color or arrange spot that does not fit to the profile', async () => {
    const base = await sliced(project(P1S))
    clearProject()
    const cfg = await sliced(project({ ...P1S, extruder_colour: ['green'], best_object_pos: '3x0.5' }))
    expect.soft(cfg['extruder_colour']).toEqual(base['extruder_colour'])
    expect.soft(cfg['best_object_pos']).toEqual(base['best_object_pos'])
  })

  it("keep the profile's bed, nozzle, clearances, firmware and connection", async () => {
    const base = await sliced(project(P1S))
    clearProject()
    const cfg = await sliced(project({
      ...P1S,
      printable_height: '400',
      nozzle_type: ['hardened_steel'],
      nozzle_hrc: '60',
      extruder_clearance_radius: '1',
      extruder_clearance_height_to_rod: '1',
      extruder_clearance_height_to_lid: '1',
      extruder_printable_height: ['400'],
      gcode_flavor: 'klipper',
      printable_area: ['0x0', '300x0', '300x300', '0x300'],
      bed_exclude_area: ['0x0', '10x0', '10x10', '0x10'],
      printer_notes: 'from the file',
      machine_max_printed_mass: '9',
      extruder_max_nozzle_count: ['3'],
      host_type: 'octoprint',
      bbl_use_printhost: '1',
    }))
    for (const k of ['printable_height', 'nozzle_type', 'nozzle_hrc', 'extruder_clearance_radius', 'extruder_clearance_height_to_rod', 'extruder_clearance_height_to_lid', 'extruder_printable_height', 'gcode_flavor', 'printable_area', 'bed_exclude_area', 'printer_notes', 'machine_max_printed_mass', 'extruder_max_nozzle_count', 'host_type', 'bbl_use_printhost']) {
      expect.soft(cfg[k], k).toEqual(base[k])
    }
  })

  it("take the file's layer height limits and printer identity, as sx project-settings does, and keep the bed height", async () => {
    const base = await sliced(project(P1S))
    clearProject()
    const cfg = await sliced(project({ ...P1S, min_layer_height: ['0.05'], max_layer_height: ['0.32'], printer_structure: 'i3', printable_height: '400' }))
    expect(base['min_layer_height']).not.toEqual([0.05])
    expect(base['max_layer_height']).not.toEqual([0.32])
    expect(base['printer_structure']).not.toBe('i3')
    expect.soft(cfg['min_layer_height']).toEqual([0.05])
    expect.soft(cfg['max_layer_height']).toEqual([0.32])
    expect.soft(cfg['printer_structure']).toBe('i3')
    expect.soft(cfg['printable_height']).toEqual(base['printable_height'])
  })

  it('stay with the project printer when the plate moves to another printer, and come back with it', async () => {
    await sliced(project({ ...P1S, ...UNLISTED }))
    set({ printerId: A1_MINI.id, printerModel: A1_MINI })
    await profileReady()
    expect(get().profile?.printerId).toBe('bambu-a1-mini')
    const own = resolveConfig(get().easy, {}) as Record<string, SettingValue>
    for (const k of Object.keys(UNLISTED)) expect.soft(resolved()[k], k).toEqual(own[k])
    set({ printerId: PROJECT_PRINTER_ID, printerModel: { id: PROJECT_PRINTER_ID, vendor: 'Bambu Lab', model: 'P1S' } })
    await profileReady()
    expect.soft(resolved()['fan_direction']).toBe('left')
    expect.soft(resolved()['machine_max_speed_x']).toEqual([500, 150])
  })
})

describe("a project's machine limits on its own printer", () => {
  it("slice at the printer's limit where the file's is above it, in normal and silent mode, and at 0", async () => {
    const base = await sliced(project(P1S))
    clearProject()
    const accel = base['machine_max_acceleration_x'] as number[]
    const speed = base['machine_max_speed_x'] as number[]
    const jerk = base['machine_max_jerk_x'] as number[]
    const cfg = await sliced(project({
      ...P1S,
      machine_max_acceleration_x: accel.map((v) => String(v * 2)),
      machine_max_speed_x: [String(speed[0]! / 2), String(speed[1]! * 3)],
      machine_max_jerk_x: jerk.map(() => '0'),
    }))
    expect.soft(cfg['machine_max_acceleration_x']).toEqual(accel)
    expect.soft(cfg['machine_max_speed_x']).toEqual([speed[0]! / 2, speed[1]])
    expect.soft(cfg['machine_max_jerk_x']).toEqual(jerk)
  })

  it('slice at a lower limit the file has', async () => {
    const base = await sliced(project(P1S))
    clearProject()
    const accel = base['machine_max_acceleration_x'] as number[]
    const cfg = await sliced(project({ ...P1S, machine_max_acceleration_x: accel.map((v) => String(v / 2)) }))
    expect(cfg['machine_max_acceleration_x']).toEqual(accel.map((v) => v / 2))
  })
})

describe('a project for a printer SlicerX has no profile for', () => {
  it("keeps the current printer's printer settings, as before", async () => {
    const own = resolveConfig(get().easy, {}) as Record<string, SettingValue>
    const cfg = await sliced(project({ printer_settings_id: 'Workshop Printer 0.4 nozzle', printer_model: 'Workshop Printer', nozzle_diameter: ['0.4'], ...UNLISTED }))
    expect(get().printerId).toBe(A1_MINI.id)
    for (const k of Object.keys(UNLISTED)) expect.soft(cfg[k], k).toEqual(own[k])
  })
})

describe("a project's end G-code on its own printer", () => {
  it('goes through the G-code review and slices with the reviewed text', async () => {
    const end = 'M104 S0\nM140 S0\nG1 Z250 F600\nM84\n'
    const cfg = await sliced(project({ ...P1S, ...UNLISTED, machine_end_gcode: end }))
    expect(get().projectPrinter?.gcodeKeys).toContain('machine_end_gcode')
    expect(cfg['machine_end_gcode']).toBe(end)
  })

  it("keeps the profile's end G-code when the file's has a line SlicerX never sends", async () => {
    const own = await sliced(project(P1S))
    clearProject()
    const cfg = await sliced(project({ ...P1S, ...UNLISTED, machine_end_gcode: 'M104 S0\nM997\n' }))
    expect(get().projectPrinter?.gcodeKeys ?? []).not.toContain('machine_end_gcode')
    expect(cfg['machine_end_gcode']).toBe(own['machine_end_gcode'])
    expect(get().openNote?.text ?? '').toContain('end G-code has lines')
  })
})
