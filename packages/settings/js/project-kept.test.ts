// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a project file names for its plate type, its prime tower spot and its filament makers reaches the slice as the
// file has it: each plate type the file format can name, the tower to the thousandth of a millimeter, and each slot's
// maker. The app's project open and the MCP server's project slices both read these.
import { describe, expect, it } from 'vitest'
import { projectBedType, sliceBedType } from './bed-type'
import { matchProjectPrinter, projectPrinterChanges, projectSettingChanges } from './project-open'
import { projectSlotVendors, projectTowerFrom, slotSettings, towerMm } from './slot-settings'
import { FLUSH_DEFAULTS } from './flush-defaults'

describe("a project's plate type", () => {
  it('reads every plate type the file format names, as the engine names it', () => {
    const names: [string, string][] = [
      ['Cool Plate', 'Cool Plate'],
      ['Engineering Plate', 'Engineering Plate'],
      ['High Temp Plate', 'High Temp Plate'],
      ['Textured PEI Plate', 'Textured PEI Plate'],
      ['Textured Cool Plate', 'Textured Cool Plate'],
      ['Supertack Plate', 'Supertack Plate'],
      // a plate's own entry spells it this way
      ['SuperTack Plate', 'Supertack Plate'],
    ]
    for (const [file, engine] of names) {
      expect(projectBedType({ curr_bed_type: file }), file).toBe(engine)
      expect(projectBedType({ curr_bed_type: [file] }), file).toBe(engine)
      expect(projectBedType({ curr_bed_type: ` ${file.toLowerCase()} ` }), file).toBe(engine)
      // the slice sends it as it is
      expect(sliceBedType({ curr_bed_type: engine })).toEqual({})
    }
  })

  it("leaves Default Plate, a name no plate has and a missing one to the printer's default", () => {
    expect(projectBedType({ curr_bed_type: 'Default Plate' })).toBeUndefined()
    expect(projectBedType({ curr_bed_type: 'Gold Plate' })).toBeUndefined()
    expect(projectBedType({ curr_bed_type: 4 })).toBeUndefined()
    expect(projectBedType({})).toBeUndefined()
    expect(sliceBedType({ default_bed_type: '4' })).toEqual({ curr_bed_type: 'Textured PEI Plate' })
  })

  it("goes with the project's settings, on its own printer and on another", () => {
    const changes = projectSettingChanges({ curr_bed_type: 'Textured PEI Plate', wall_loops: '3' }, {} as never)
    expect(changes.taken['curr_bed_type']).toBe('Textured PEI Plate')
    expect(changes.values['curr_bed_type']).toBe('Textured PEI Plate')
    expect(projectSettingChanges({ curr_bed_type: 'Default Plate' }, {} as never).taken).not.toHaveProperty('curr_bed_type')
    // the same plate already in the settings is taken, not a change
    expect(projectSettingChanges({ curr_bed_type: 'Cool Plate' }, { curr_bed_type: 'Cool Plate' } as never).values).not.toHaveProperty('curr_bed_type')

    const p1s = {
      printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
      printer_model: 'Bambu Lab P1S',
      nozzle_diameter: ['0.4'],
      curr_bed_type: 'Textured PEI Plate',
      // the file lists only its wall loops as changed; the plate type is no preset setting and is kept anyway
      different_settings_to_system: ['wall_loops', '', ''],
      wall_loops: '3',
    }
    const match = matchProjectPrinter(p1s)
    expect(match?.kind).toBe('match')
    expect(projectPrinterChanges(p1s, match, {} as never, 0.4).values['curr_bed_type']).toBe('Textured PEI Plate')
    expect(projectPrinterChanges(p1s, null, {} as never, 0.4).values['curr_bed_type']).toBe('Textured PEI Plate')
  })
})

describe("a project's tower spot", () => {
  it('keeps the file\'s coordinates, only the floating point noise taken off', () => {
    expect(projectTowerFrom({ wipe_tower_x: ['165.375'], wipe_tower_y: ['211.626'] }, [0, 0])).toEqual({ x: 165.375, y: 211.626 })
    // a bed whose area starts off 0, 0: on the plate and back on the printer gives the file's numbers again
    const origin: [number, number] = [-2.5, 3.1]
    const spot = projectTowerFrom({ wipe_tower_x: '15.2345', wipe_tower_y: '211.626' }, origin)!
    expect(spot).toEqual({ x: 17.7345, y: 208.526 })
    const keys = slotSettings({ cfg: {}, list: [{ color: '#ffffff', type: 'PLA', brand: '' }, { color: '#ff0000', type: 'PLA', brand: '' }], flush: FLUSH_DEFAULTS, nozzleVolume: 0, projectFlush: null, tower: { auto: false, ...spot }, origin })
    expect(keys['wipe_tower_x']).toBe(15.2345)
    expect(keys['wipe_tower_y']).toBe(211.626)
    expect(keys['prime_tower_auto_position']).toBe(false)
  })

  it('takes off only what is below a millionth of a millimeter', () => {
    expect(towerMm(211.626 + 1e-12)).toBe(211.626)
    expect(towerMm(0.1 + 0.2)).toBe(0.3)
    expect(towerMm(12.3456789)).toBe(12.345679)
  })
})

describe("a project's filament makers", () => {
  it("reads each slot's maker, and none for (Undefined), a blank or text that is no name", () => {
    expect(projectSlotVendors({ filament_vendor: ['Bambu Lab', 'Polymaker', '(Undefined)', ' eSUN ', ''] })).toEqual(['Bambu Lab', 'Polymaker', '', 'eSUN', ''])
    expect(projectSlotVendors({ filament_vendor: 'Generic' })).toEqual(['Generic'])
    expect(projectSlotVendors({ filament_vendor: ['Bad\nG28', 'a;b', 'x'.repeat(65), 3] })).toEqual(['', '', '', ''])
    expect(projectSlotVendors({})).toEqual([])
  })

  it('slice as the slot brands give them, (Undefined) for a slot without one', () => {
    const keys = slotSettings({ cfg: {}, list: [{ color: '#ffffff', type: 'PLA', brand: 'Bambu Lab' }, { color: '#ff0000', type: 'PLA', brand: '' }], flush: FLUSH_DEFAULTS, nozzleVolume: 0, projectFlush: null, tower: { auto: true, x: 0, y: 0 }, origin: [0, 0] })
    expect(keys['filament_vendor']).toEqual(['Bambu Lab', '(Undefined)'])
  })
})
