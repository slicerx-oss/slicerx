// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, describe, expect, it } from 'vitest'
import { defaultConfig } from '@slicerx/settings/defaults'
import { goalEasy, presetOwnValue, resolveConfig, setProfileLayer } from '../src/adapters/config'
import { buildProfileLayer } from '../src/adapters/profile'
import { changedControls } from '../src/state/profile-sync'
import { trustOptions } from '../src/state/actions'

afterEach(() => setProfileLayer(null, []))

describe('printer, filament and process layer', () => {
  it('a P1S layer carries the machine, the bed and limits, and the shipped G-code', async () => {
    const layer = await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model: 'P1S' }, tier: 'standard', slots: [{ type: 'PLA' }] })
    expect(layer?.source).toBe('orca')
    expect(layer!.printerId).toBe('bambu-p1s')
    expect(layer!.bed).toEqual({ widthMm: 256, depthMm: 256, heightMm: 250 })
    expect(layer!.shippedGcode).toBe(true)
    expect(String(layer!.values['machine_start_gcode'])).toContain('machine: P1S')
    expect(layer!.limits.nozzleMaxC).toBeGreaterThan(200)
  })

  it('a bed that is not square comes from the printer', async () => {
    const layer = await buildProfileLayer({ printer: { vendor: 'Prusa Research', model: 'MK4S' }, tier: 'standard', slots: [{ type: 'PLA' }] })
    expect(layer!.bed.widthMm).toBe(250)
    expect(layer!.bed.depthMm).toBe(210)
  })

  it('a printer the profiles do not know gets no layer', async () => {
    expect(await buildProfileLayer({ printer: { vendor: 'Nobody', model: 'X1' }, tier: 'standard', slots: [{ type: 'PLA' }] })).toBeNull()
  })

  it('a three color print has one filament entry per slot', async () => {
    const layer = await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model: 'P1S' }, tier: 'standard', slots: [{ type: 'PLA' }, { type: 'PETG' }, { type: 'PLA' }] })
    expect((layer!.values['nozzle_temperature'] as number[]).length).toBe(3)
  })

  it('Easy changes only the controls that were moved, so the maker preset stands otherwise', async () => {
    const layer = await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model: 'P1S' }, tier: 'standard', slots: [{ type: 'PLA' }] })
    const easy = goalEasy('standard')
    setProfileLayer(layer!.values, [])
    const untouched = resolveConfig(easy, {})
    expect(untouched['outer_wall_speed']).toEqual(layer!.values['outer_wall_speed'])
    expect(untouched['enable_support']).toBe(layer!.values['enable_support'] ?? false)
    setProfileLayer(layer!.values, ['supports'])
    const moved = resolveConfig({ ...easy, supports: 'auto' }, {})
    expect(moved['enable_support']).toBe(true)
    // Speeds stay the maker's.
    expect(moved['outer_wall_speed']).toEqual(layer!.values['outer_wall_speed'])
  })

  it('user overrides win over the layer', async () => {
    const layer = await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model: 'P1S' }, tier: 'standard', slots: [{ type: 'PLA' }] })
    setProfileLayer(layer!.values, [])
    expect(resolveConfig(goalEasy('standard'), { wall_loops: 5 })['wall_loops']).toBe(5)
  })

  it('names the Easy controls that differ', () => {
    expect(changedControls(goalEasy('standard'), { ...goalEasy('standard'), brim: false })).toEqual(['brim'])
    expect(changedControls(goalEasy('draft'), goalEasy('strong')).length).toBeGreaterThan(1)
  })
})

describe('filament presets', () => {
  const P1S = { vendor: 'Bambu Lab', model: 'P1S' }

  it('a matched product is used whole, with the variant that suits the printer and its own extruder variant entry', async () => {
    const layer = await buildProfileLayer({ printer: P1S, tier: 'standard', slots: [{ type: 'PETG', vendor: 'BBL', family: 'Bambu PETG HF' }] })
    expect(layer!.values['filament_type']).toEqual(['PETG'])
    expect((layer!.values['nozzle_temperature'] as number[]).length).toBe(1)
    expect(layer!.values['filament_vendor']).toEqual(['Bambu Lab'])
  })

  it('a carbon fiber filament keeps its nozzle hardness, so the engine can warn about the stock nozzle as Orca does', async () => {
    const layer = await buildProfileLayer({ printer: P1S, tier: 'standard', slots: [{ type: 'PETG', vendor: 'BBL', family: 'Bambu PET-CF' }] })
    expect(layer!.values['required_nozzle_HRC']).toEqual([40])
    expect(layer!.values['nozzle_type']).toEqual(['stainless_steel'])
  })

  it('a material with no product gets the generic preset of that material, not the knowledge base', async () => {
    const layer = await buildProfileLayer({ printer: P1S, tier: 'standard', slots: [{ type: 'TPU' }] })
    expect(layer!.values['filament_type']).toEqual(['TPU'])
    expect(layer!.values['filament_vendor']).not.toEqual(['(Undefined)'])
  })

  it('picks the variant named for the printer, else one compatible with it, else System', async () => {
    const { loadVendorFile } = await import('@slicerx/settings')
    const { pickVariant } = await import('../src/adapters/profile')
    const file = (await loadVendorFile('BBL'))!
    expect(pickVariant(file, 'Bambu PETG HF', 'Bambu Lab P1S 0.4 nozzle')).toBe('BBL P1S 0.4 nozzle')
    const lib = (await loadVendorFile('OrcaFilamentLibrary'))!
    expect(pickVariant(lib, 'Panchroma PLA', 'Bambu Lab P1S 0.4 nozzle')).toBeDefined()
  })
})

describe('Easy sliders over a maker preset', () => {
  it('stand where the preset is: the layer height, walls and infill they would give match the preset', async () => {
    const { inferEasy } = await import('../src/adapters/config')
    const { applyEasy } = await import('@slicerx/settings/easy')
    const layer = await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model: 'P1S' }, tier: 'standard', slots: [{ type: 'PLA' }] })
    const cfg = { ...(await import('@slicerx/settings/defaults')).defaultConfig(), ...layer!.values } as never
    const easy = goalEasy('standard')
    const at = inferEasy(cfg, easy)
    const a = applyEasy({ ...easy, detail: at.detail }, cfg, new Set(['detail']))
    expect(a['layer_height']).toBe((cfg as Record<string, unknown>)['layer_height'])
    const b = applyEasy({ ...easy, strength: at.strength }, cfg, new Set(['strength']))
    expect(b['wall_loops']).toBe((cfg as Record<string, unknown>)['wall_loops'])
  })
})

describe('nozzle size', () => {
  const P1S = { vendor: 'Bambu Lab', model: 'P1S' }

  it('a 0.6 mm nozzle resolves the 0.6 presets: the nozzle, wider lines and thicker layers', async () => {
    const four = await buildProfileLayer({ printer: P1S, tier: 'standard', slots: [{ type: 'PLA' }] })
    const six = await buildProfileLayer({ printer: P1S, tier: 'standard', slots: [{ type: 'PLA' }], nozzle: 0.6, nozzleFrom: 'choice' })
    expect(six!.nozzle).toBe(0.6)
    expect(six!.nozzleFrom).toBe('choice')
    expect(six!.values['nozzle_diameter']).toEqual([0.6])
    // Wider lines for the bigger nozzle (a value equal to the schema default is not stored, so read it with the defaults).
    const w = (l: typeof four): number => Number({ ...defaultConfig(), ...l!.values }['outer_wall_line_width'])
    expect(w(six)).toBeGreaterThan(w(four))
    expect(six!.nozzles).toContain(0.8)
  })

  it('a size the printer does not offer falls back to its default nozzle', async () => {
    const layer = await buildProfileLayer({ printer: P1S, tier: 'standard', slots: [{ type: 'PLA' }], nozzle: 0.35 })
    expect(layer!.nozzle).toBe(0.4)
  })
})

describe('what the engine may trust', () => {
  const profile = { printerId: 'bambu-p1s', nozzle: 0.4, nozzles: [0.2, 0.4, 0.6, 0.8], nozzleFrom: 'default' as const, tier: 'standard', source: 'orca' as const, shippedGcode: true, gcodeKeys: ['machine_start_gcode', 'machine_end_gcode'], limits: { nozzleMaxC: 300, bedMaxC: 100 } }

  it('trusts the shipped G-code and sends the limits', () => {
    expect(trustOptions({ profile, overrides: {} })).toEqual({ trustedGcode: true, machineLimits: { nozzleMaxC: 300, bedMaxC: 100 } })
  })

  it('does not trust the text once a G-code setting is overridden (an edit, an import)', () => {
    const t = trustOptions({ profile, overrides: { machine_start_gcode: 'M104 S0' } })
    expect(t.trustedGcode).toBeUndefined()
    expect(t.machineLimits).toBeDefined()
    expect(trustOptions({ profile, overrides: { layer_change_gcode: 'G4 P1' } }).trustedGcode).toBeUndefined()
  })

  it('does not trust G-code when the model has no shipped text, or no profile matches', () => {
    expect(trustOptions({ profile: { ...profile, shippedGcode: false }, overrides: {} }).trustedGcode).toBeUndefined()
    expect(trustOptions({ profile: null, overrides: {} })).toEqual({})
  })
})

describe('SlicerX default wall generator on a maker preset', () => {
  const printers = [
    { vendor: 'Bambu Lab', model: 'P1S' },
    { vendor: 'Prusa Research', model: 'MK4S' },
    { vendor: 'Creality', model: 'K1' },
  ]

  for (const printer of printers) {
    it(`${printer.model}: aegis unless the person chose, and the preset's own one click away`, async () => {
      const layer = await buildProfileLayer({ printer, tier: 'standard', slots: [{ type: 'PLA' }] })
      expect(layer, printer.model).not.toBeNull()
      const own = layer!.values['wall_generator']
      const easy = goalEasy('standard')
      setProfileLayer(layer!.values, [])
      // The vendor data is untouched; the resolved config shows aegis.
      expect(layer!.values['wall_generator']).toBe(own)
      expect(resolveConfig(easy, {})['wall_generator']).toBe('aegis')
      // The person's own choice wins, including going back to the preset's.
      expect(resolveConfig(easy, { wall_generator: 'classic' })['wall_generator']).toBe('classic')
      if (own !== undefined && own !== 'aegis') {
        expect(presetOwnValue('wall_generator')).toBe(own)
        expect(resolveConfig(easy, { wall_generator: own })['wall_generator']).toBe(own)
      } else {
        expect(presetOwnValue('wall_generator')).toBeNull()
      }
    })
  }

  it('without a maker preset the schema default stands and there is nothing to restore', () => {
    setProfileLayer(null, [])
    expect(resolveConfig(goalEasy('standard'), {})['wall_generator']).toBe('aegis')
    expect(presetOwnValue('wall_generator')).toBeNull()
  })
})
