// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { followsSlotMap, slotMapLine } from '@slicerx/contracts'
import { defaultOptions, mergeOptions, optionLines, optionTip, printEnding, slotMapFor, startSlotMap, supportedOptions, withoutSlotMap } from '../src/send/options'

const ids = (v: string, m: string, plugin: string, cam = true) => supportedOptions({ vendor: v, model: m, plugin }, { cameraAvailable: cam }).map((s) => s.id)

describe('send options', () => {
  it('offers each Bambu Lab model what Bambu Studio offers it', () => {
    expect(ids('Bambu Lab', 'X1 Carbon', 'bambu-lan')).toEqual(['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse', 'firstLayerInspection'])
    expect(ids('Bambu Lab', 'A1', 'bambu-lan')).not.toContain('firstLayerInspection')
    expect(ids('Bambu Lab', 'H2D', 'bambu-lan')).toEqual(['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse'])
    expect(ids('Bambu Lab', 'P1S', 'bambu-lan')).toEqual(['bedLeveling', 'vibrationCompensation', 'timelapse'])
    expect(ids('Bambu Lab', 'P1S', 'bambu-lan', false)).toEqual(['bedLeveling', 'vibrationCompensation'])
    expect(ids('Voron Design', 'Voron 2.4', 'bambuddy')).toEqual(['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse', 'firstLayerInspection'])
  })

  it("defaults each model the way Bambu Studio does, Auto shown as on", () => {
    const d = (m: string) => defaultOptions(supportedOptions({ vendor: 'Bambu Lab', model: m, plugin: 'bambu-lan' }, { cameraAvailable: true }))
    expect(d('H2D')).toEqual({ bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: true })
    expect(d('X1 Carbon')).toEqual({ bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: true, firstLayerInspection: true })
    expect(d('P1P')).toEqual({ bedLeveling: true, vibrationCompensation: false, timelapse: true })
    expect(d('A1')).toEqual({ bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: false })
    expect(d('A1 mini')).toEqual({ bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: false })
  })

  it('gives every option a tooltip that says what it does, when to use it and the time it adds', () => {
    for (const s of supportedOptions({ vendor: 'Bambu Lab', model: 'X1 Carbon', plugin: 'bambu-lan' }, { cameraAvailable: true })) {
      expect(s.tip.what.length).toBeGreaterThan(20)
      expect(s.tip.when).toMatch(/Turn it|Leave it|Keep it/)
      expect(s.tip.time).toMatch(/^Adds /)
      expect(optionTip(s)).toContain(s.tip.time)
    }
  })

  it('offers only what the connection lists: Elegoo two, Klipper none', () => {
    expect(ids('Elegoo', 'Centauri Carbon', 'elegoo')).toEqual(['bedLeveling', 'timelapse'])
    expect(ids('Elegoo', 'Centauri Carbon', 'elegoo', false)).toEqual(['bedLeveling'])
    expect(ids('Prusa', 'Core One', 'moonraker')).toEqual([])
  })

  it('treats a Bambu Lab printer as a Bambu connection when the plugin id is not the catalog one', () => {
    expect(ids('Bambu Lab', 'X1 Carbon', 'sx-link')).toContain('bedLeveling')
  })

  it('keeps saved choices only for options the printer supports', () => {
    const specs = supportedOptions({ vendor: 'Elegoo', model: 'CC', plugin: 'elegoo' }, { cameraAvailable: true })
    expect(mergeOptions(specs, { bedLeveling: false, flowCalibration: false })).toEqual({ bedLeveling: false, timelapse: false })
  })

  it('maps used slots to the printer slot ids', () => {
    expect(slotMapFor([1, 3], [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }])).toEqual({ 1: 'A1', 3: 'A3' })
    expect(slotMapFor([2], [])).toEqual({})
  })

  it('lists each choice for the approval card', () => {
    const specs = supportedOptions({ vendor: 'Elegoo', model: 'CC', plugin: 'elegoo' }, { cameraAvailable: true })
    expect(optionLines(specs, { bedLeveling: true, timelapse: false })).toEqual(['Bed leveling: on', 'Timelapse: off'])
  })
})

describe('send file name', () => {
  it('applies the name rules of the reference dialog', async () => {
    const { jobNameProblem, withGcodeEnding } = await import('../src/send/options')
    expect(jobNameProblem('bracket')).toBeNull()
    expect(jobNameProblem('')).toMatch(/empty/)
    expect(jobNameProblem(' lead')).toMatch(/start with a space/)
    expect(jobNameProblem('trail ')).toMatch(/end with a space/)
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a?b', 'a*b', 'a"b', 'a<b', 'a|b', 'a\u0001b']) expect(jobNameProblem(bad), bad).toMatch(/cannot contain/)
    expect(jobNameProblem('x'.repeat(101))).toMatch(/too long/)
    expect(withGcodeEnding('part')).toBe('part.gcode')
    expect(withGcodeEnding('part.GCODE')).toBe('part.GCODE')
    expect(withGcodeEnding('part.bgcode')).toBe('part.bgcode')
  })
})

describe('filament mapping and backup', () => {
  const slots = [
    { id: 'A1', material: 'PLA', color: '#ff0000' },
    { id: 'A2', material: 'PLA', color: '#fa0505' },
    { id: 'A3', material: 'PETG', color: '#ff0000' },
    { id: 'A4', material: 'PLA', color: '#0000ff' },
  ]

  it('a backup is a loaded slot of the same material and a close color', async () => {
    const { backupSlots } = await import('../src/send/options')
    const f = { index: 1, color: '#ff0000', type: 'PLA' }
    expect(backupSlots(f, { 1: 'A1' }, slots).map((s) => s.id)).toEqual(['A2'])
  })

  it('a slot already used by another filament is not a backup, and neither is the external spool', async () => {
    const { backupSlots } = await import('../src/send/options')
    const f = { index: 1, color: '#ff0000', type: 'PLA' }
    expect(backupSlots(f, { 1: 'A1', 2: 'A2' }, slots)).toEqual([])
    expect(backupSlots(f, { 1: 'A1' }, [...slots, { id: '1', material: 'PLA', color: '#ff0000' }]).map((s) => s.id)).toEqual(['A2'])
  })

  it('finds two filaments sent to one slot', async () => {
    const { duplicateTargets } = await import('../src/send/options')
    expect(duplicateTargets({ 1: 'A1', 2: 'A2' })).toEqual([])
    expect(duplicateTargets({ 1: 'A1', 2: 'A1', 3: '1' })).toEqual(['A1'])
  })
})

describe('slot map contract', () => {
  // The sheet counts filaments from 1; StartOptions.slotMap counts them from 0 (filament 1 is T0 and ams_mapping[0]).
  it('turns the sheet map into 0 based keys in one place', () => {
    expect(startSlotMap(slotMapFor([1], [{ id: 'A1' }]))).toEqual({ 0: 'A1' })
    expect(startSlotMap({ 1: 'A1', 2: 'A3' })).toEqual({ 0: 'A1', 1: 'A3' })
    expect(startSlotMap({ 1: '1' })).toEqual({ 0: '1' })
    expect(startSlotMap({ 0: 'A1' })).toEqual({})
    expect(slotMapLine(startSlotMap({ 1: 'A1', 2: 'A3' }))).toBe('Filament slots: filament 1 from slot A1, filament 2 from slot A3')
  })

  it('sends a map only where the printer follows it', () => {
    expect(followsSlotMap('bambu-lan', 'plate.gcode.3mf')).toBe(true)
    expect(followsSlotMap('bambu-lan', 'plate.gcode')).toBe(false)
    expect(followsSlotMap('bambuddy', 'plate.gcode.3mf')).toBe(true)
    expect(followsSlotMap('bambuddy', 'plate.gcode')).toBe(false)
    expect(followsSlotMap('moonraker', 'plate.gcode.3mf')).toBe(false)
    expect(printEnding('bambu-lan')).toBe('.gcode.3mf')
    expect(printEnding('bambuddy')).toBe('.gcode.3mf')
    expect(printEnding('moonraker')).toBe('.gcode')
    expect(withoutSlotMap({ timelapse: true, slotMap: { 1: 'A1' } })).toEqual({ timelapse: true })
  })
})

