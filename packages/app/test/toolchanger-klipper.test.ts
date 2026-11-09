// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Klipper tool changer from setup to Preview: the connection test reads the docks from the printer's [tool] sections
// (a mocked Moonraker reply as sx-link serializes it), setup keeps them with the printer, and the tool changer Preview
// plays docks the tools there, measured where the config gave values and estimated where it did not.
import { describe, expect, it } from 'vitest'
import type { PrinterHardware, ToolDock } from '@slicerx/contracts'
import { EMPTY_FORM, withHardware } from '../src/first-run/printer-form'
import { fromLinkResult, type TestStepId } from '../src/first-run/setup-registry'
import { buildProfileLayer } from '../src/adapters/profile'
import { toolChangerFor } from '../src/lib/toolchanger'
import { inputOf } from '../src/state/profile-sync'
import { normalizePrefs } from '../src/state/prefs'
import { get, set, type ProfileInfo } from '../src/state/store'

const steps: { id: TestStepId; ok: boolean | null }[] = [{ id: 'reach', ok: true }, { id: 'sign_in', ok: true }, { id: 'read_state', ok: true }, { id: 'read_temperatures', ok: true }]
const PATH = [{ y: 9.5, z: 4 }, { y: 9.5, z: 2 }, { y: 5.5, z: 0 }, { y: 0, z: 0, f: 0.5 }, { y: 0, z: -10 }, { y: 16, z: -10 }]
/** The hardware sx-link sends for a two-tool StealthChanger build (see the Moonraker driver's docks tests). */
const HW: PrinterHardware = {
  firmware: 'Klipper v0.12.0',
  kinematics: 'corexy',
  extruders: [{ tool: 0, nozzleDiameterMm: 0.4 }, { tool: 1, nozzleDiameterMm: 0.4 }],
  toolDocks: [
    { tool: 0, parkMm: [28, -71, 381], safeYMm: 20, path: PATH },
    { tool: 1, parkMm: [104, -71, 381], safeYMm: 20, path: PATH },
  ],
}

const profile = { printerId: 'generic-klipper', nozzle: 0.4, nozzles: [0.4, 0.4], nozzleFrom: 'printer', tier: 'standard', source: 'slicerx' } as unknown as ProfileInfo
const klipper2 = { nozzle_diameter: ['0.4', '0.4'], gcode_flavor: 'klipper', printable_area: ['0x0', '250x0', '250x250', '0x250'] }
const bed = { widthMm: 250, depthMm: 250, heightMm: 250 }

describe('setup reads a Klipper tool changer', () => {
  it('takes the docks from the connection test, as a tool changer with a nozzle per tool', () => {
    const outcome = fromLinkResult({ ok: true, state: 'idle', steps, hardware: HW })
    expect(outcome.filamentSystem).toBe('toolchanger')
    expect(outcome.slotCount).toBe(2)
    const f = withHardware(EMPTY_FORM, outcome.hardware!)
    expect(f.toolDocks).toEqual(HW.toolDocks)
    expect(f.nozzles).toHaveLength(2)
    expect(f.filament).toEqual({ kind: 'single', units: 1, slots: 2 })
  })

  it('reads a printer with no [tool] sections as before', () => {
    const outcome = fromLinkResult({ ok: true, state: 'idle', steps, hardware: { ...HW, toolDocks: [] } })
    expect(outcome.filamentSystem).toBeUndefined()
    expect(withHardware(EMPTY_FORM, outcome.hardware!).toolDocks).toBeUndefined()
  })

  it('keeps saved docks across a restart and drops values that are out of range or not numbers', () => {
    const back = normalizePrefs({
      printerDocks: {
        'klipper-1': [...HW.toolDocks!, { tool: 2, parkMm: [1, 'x', 3], safeYMm: 1e9, path: [{ y: 1, z: 1 }] }],
        'klipper-2': [],
      },
    })
    expect(back.printerDocks?.['klipper-1']).toEqual([...HW.toolDocks!, { tool: 2 }])
    expect(back.printerDocks?.['klipper-2']).toEqual([])
    expect(normalizePrefs({ printerDocks: { bad: [{ tool: 99 }] } }).printerDocks).toEqual({})
  })
})

describe('a declared Klipper tool changer slices with a tool per extruder', () => {
  it('asks the profile for a tool per extruder only when the printer is declared a tool changer', () => {
    const model = { id: 'klipper-1', vendor: 'Other printer', model: 'Klipper printer' }
    set({ printerExtruders: { 'klipper-1': [{ mm: 0.4 }, { mm: 0.4 }] }, printerDocks: { 'klipper-1': HW.toolDocks! }, handPrinters: [] })
    expect(inputOf(get(), model as never, 'standard').toolchanger).toBe(true)
    set({ printerDocks: {} })
    expect(inputOf(get(), model as never, 'standard').toolchanger).toBeUndefined()
    set({ printerExtruders: {} })
  })

  it('gives the generic Klipper profile two nozzles and no shared nozzle for two tools', async () => {
    const layer = await buildProfileLayer({ printer: { vendor: 'Other printer', model: 'Klipper printer' }, tier: 'standard', slots: [], extruders: [{ mm: 0.4 }, { mm: 0.4 }], toolchanger: true })
    expect(layer?.printerId).toBe('generic-klipper')
    expect((layer?.values['nozzle_diameter'] as unknown[]).length).toBe(2)
    expect(Number(layer?.values['single_extruder_multi_material'])).toBe(0)
    // Not declared: one nozzle, as before.
    const plain = await buildProfileLayer({ printer: { vendor: 'Other printer', model: 'Klipper printer' }, tier: 'standard', slots: [], extruders: [{ mm: 0.4 }, { mm: 0.4 }] })
    expect((plain?.values['nozzle_diameter'] as unknown[]).length).toBe(1)
  })
})

describe('the tool changer Preview plays for a Klipper printer', () => {
  const docksFor = (docks: ToolDock[] | undefined, hand?: 'toolchanger') => {
    set({
      profile,
      overrides: klipper2,
      bed,
      printerId: 'klipper-1',
      printerDocks: docks ? { 'klipper-1': docks } : {},
      handPrinters: hand ? [{ id: 'klipper-1', name: 'Shop Voron', profileId: 'generic-klipper', vendor: 'Other printer', model: 'Klipper printer', nozzleCount: 2, filamentSystem: hand }] : [],
    })
    return toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })
  }

  it('docks the tools where the printer config says (measured)', () => {
    const spec = docksFor(HW.toolDocks)
    expect(spec?.kind).toBe('klipper-dock')
    expect(spec?.klipper?.docks).toEqual([{ x: 28, y: -71, z: 381, measured: true }, { x: 104, y: -71, z: 381, measured: true }])
    expect(spec?.klipper?.measured).toEqual({ safeY: true, path: true })
  })

  it('estimates the dock from the nozzle count when the config gave nothing it could read', () => {
    const spec = docksFor([])
    expect(spec?.kind).toBe('klipper-dock')
    expect(spec?.klipper?.docks.every((d) => !d.measured)).toBe(true)
    expect(spec?.klipper?.measured).toEqual({ safeY: false, path: false })
  })

  it('docks a stored hand-added record with filamentSystem toolchanger, estimated', () => {
    const spec = docksFor(undefined, 'toolchanger')
    expect(spec?.kind).toBe('klipper-dock')
    expect(spec?.klipper?.docks.every((d) => !d.measured)).toBe(true)
  })

  it('plays no dock for a Klipper printer that is not declared a tool changer', () => {
    expect(docksFor(undefined)?.kind).toBe('dual-nozzle')
    set({ printerDocks: {}, handPrinters: [], printerId: '' })
  })
})
