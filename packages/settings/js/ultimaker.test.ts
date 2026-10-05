// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The UltiMaker S series, from UltiMaker Cura's definitions (packages/profiles/cura/ultimaker.json, LGPL-3.0-or-later):
// the values Cura 5.13 resolves for each machine, print core and quality, under Orca's keys.
import curaJson from '@slicerx/profiles/cura/ultimaker.json'
import { describe, expect, it } from 'vitest'
import { importFlat } from './import'
import { gcodeStatus, listProcessPresets, machineEntry, printerConfig, printerProfile, processConfig, processSpeedSource } from './profiles'
import { settingDef } from './schema'

const cura = curaJson as unknown as { comment: string; license: string; cura: { version: string }; models: Record<string, { machine: Record<string, unknown>; nozzles: Record<string, { printCores: string[]; differs: Record<string, unknown> }> }> }
const ids = ['ultimaker-s3', 'ultimaker-s5', 'ultimaker-s7', 'ultimaker-s6', 'ultimaker-s8']
const cfg = (id: string, n?: number) => printerConfig(id, n) as unknown as Record<string, unknown>

describe('UltiMaker S series', () => {
  it('says where the data comes from and its license', () => {
    expect(cura.license).toBe('LGPL-3.0-or-later')
    expect(cura.comment).toMatch(/UltiMaker Cura/)
    expect(cura.comment).toMatch(/LGPL-3\.0-or-later/)
    expect(cura.cura.version).toBe('5.13.0')
    expect(Object.keys(cura.models)).toEqual(ids)
  })

  it('holds only printer keys the schema knows', () => {
    for (const id of ids) {
      const e = cura.models[id]!
      const r = importFlat(e.machine)
      expect(r.unknownKeys, id).toEqual([])
      expect(r.invalidKeys, id).toEqual([])
      for (const k of Object.keys(e.machine)) expect(settingDef(k)?.section, `${id} ${k}`).toBe('printer')
    }
  })

  it('has the beds, flavors and print cores of the Cura definitions', () => {
    expect(cfg('ultimaker-s3')).toMatchObject({ printable_height: 200, gcode_flavor: 'griffin', printer_model: 'Ultimaker S3' })
    expect(cfg('ultimaker-s3')['printable_area']).toEqual([[0, 0], [230, 0], [230, 190], [0, 190]])
    for (const id of ['ultimaker-s5', 'ultimaker-s7']) {
      expect(cfg(id)).toMatchObject({ printable_height: 300, gcode_flavor: 'griffin', print_core: ['AA 0.4', 'BB 0.4'] })
      expect(cfg(id)['printable_area']).toEqual([[0, 0], [330, 0], [330, 240], [0, 240]])
    }
    for (const id of ['ultimaker-s6', 'ultimaker-s8']) expect(cfg(id)).toMatchObject({ gcode_flavor: 'cheetah', print_core: ['AA+ 0.4', 'BB 0.4'] })
    // The right core sits 22 mm to the right; the S5 switches cores at the back right, the S3 in its own corner.
    expect(cfg('ultimaker-s5')['extruder_offset']).toEqual([[0, 0], [22, 0]])
    expect(cfg('ultimaker-s5')['toolchange_park_position']).toEqual([[330, 237], [330, 219]])
    expect(cfg('ultimaker-s3')['toolchange_park_position']).toEqual([[180, 180], [180, 180]])
    // Switch retraction: the heat zone length on an AA core, 12 mm on a BB core, at 20 mm/s.
    expect(cfg('ultimaker-s5')).toMatchObject({ retract_length_toolchange: [16, 12], retract_speed_toolchange: [20, 20], retraction_length: [6.5, 6.5], z_hop: [2, 2] })
    expect(cfg('ultimaker-s8')).toMatchObject({ z_hop: [1, 1], deretract_speed_extruder_change: [15, 15] })
    for (const id of ids) expect(printerProfile(id)).toMatchObject({ nozzleCount: 2, directDrive: false })
  })

  it('names the print cores of every nozzle size', () => {
    expect(cfg('ultimaker-s5', 0.25)['print_core']).toEqual(['AA 0.25', 'AA 0.25'])
    expect(cfg('ultimaker-s5', 0.8)['print_core']).toEqual(['AA 0.8', 'BB 0.8'])
    expect(cfg('ultimaker-s5', 0.6)['print_core']).toEqual(['CC 0.6', 'CC 0.6'])
    expect(cfg('ultimaker-s8', 0.6)['print_core']).toEqual(['CC+ 0.6', 'CC+ 0.6'])
    for (const id of ids) for (const n of Object.keys(machineEntry(id)?.nozzles ?? {})) expect((cfg(id, Number(n))['nozzle_diameter'] as number[])[0]).toBe(Number(n))
  })

  it('takes the speeds of Cura quality profiles per tier', () => {
    expect(processSpeedSource('ultimaker-s5', 'draft')).toBe('Cura 5.13.0/ultimaker_s5/draft AA 0.4 PLA')
    expect(processSpeedSource('ultimaker-s5', 'strong')).toBe(processSpeedSource('ultimaker-s5', 'standard'))
    const draft = processConfig('draft', 0.4, 'ultimaker-s5') as unknown as Record<string, unknown>
    expect(draft).toMatchObject({ layer_height: 0.2, travel_speed: [150], default_acceleration: [3500], default_jerk: [20], ooze_prevention: true })
    expect(listProcessPresets(0.4, 'ultimaker-s5').map((p) => p.label)).toEqual(['0.20 mm Draft', '0.15 mm Standard', '0.10 mm Fine', '0.06 mm Extra fine', '0.15 mm Strong'])
  })

  it('has its G-code written by the engine, with Cheetah machines starting with the undercut', () => {
    for (const id of ids) expect(gcodeStatus(id), id).toBe('written')
    expect(cfg('ultimaker-s5')['machine_start_gcode']).toBe('')
    expect(cfg('ultimaker-s8')['machine_start_gcode']).toBe('M213 U0.1 ;undercut 0.1mm')
  })
})
