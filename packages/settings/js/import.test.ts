// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { EASY_DEFAULTS } from '@slicerx/contracts/settings'
import { applyEasy } from './easy'
import { ProfileError, exportOrcaProfile, importOrcaProfile, mergeConfigs } from './import'
import { allProfileNames, loadProfile, vendorResolver } from './testkit'

describe('a process profile with an inherits chain', () => {
  const r = loadProfile('demo', '0.20mm Standard @Demo')
  it('resolves the whole inherits chain', () => {
    expect(r.chain).toEqual(['0.20mm Standard @Demo', 'fdm_demo_process_single_0.20', 'fdm_demo_process_single_common', 'fdm_demo_process_common'])
    expect(r.section).toBe('process')
  })
  it('reports no unknown or invalid keys, and lists the keys Orca drops as ignored', () => {
    expect(r.unknownKeys).toEqual([])
    expect(r.invalidKeys).toEqual([])
    expect(r.ignoredKeys).toEqual(['enable_height_slowdown'])
  })
  it('types the values', () => {
    expect(r.config['layer_height']).toBe(0.2)
    expect(r.config['wall_loops']).toBe(2)
    expect(r.config['sparse_infill_density']).toBe(15)
    expect(r.config['enable_support']).toBe(false)
    expect(r.config['line_width']).toBe('0.42')
    expect(r.config['outer_wall_speed']).toEqual([200, 350])
  })
  it('lets the child override the parent', () => {
    const resolve = vendorResolver('demo')
    const child = resolve('0.20mm Standard @Demo') as Record<string, unknown>
    const parent = resolve('fdm_demo_process_single_0.20') as Record<string, unknown>
    const grand = resolve('fdm_demo_process_single_common') as Record<string, unknown>
    expect(child['outer_wall_speed']).not.toEqual(grand['outer_wall_speed'])
    expect(r.config['outer_wall_speed']).toEqual([200, 350])
    const alone = importOrcaProfile({ ...parent, name: 'parent only' }, resolve)
    expect(alone.config['outer_wall_speed']).toEqual([60, 60])
  })
})

describe('a printer profile', () => {
  const r = loadProfile('demo', 'Demo Printer 0.4 nozzle')
  it('imports with typed geometry, lists and comma strings', () => {
    expect(r.section).toBe('printer')
    expect(r.chain).toHaveLength(3)
    expect(r.unknownKeys).toEqual([])
    expect(r.invalidKeys).toEqual([])
    expect(r.config['printable_area']).toEqual([[0, 0], [256, 0], [256, 256], [0, 256]])
    expect(r.config['printable_height']).toBe(250)
    expect(r.config['nozzle_diameter']).toEqual([0.4])
    expect(r.config['machine_min_travel_rate']).toEqual([0, 0])
  })
})

describe('filament with nil entries', () => {
  const r = loadProfile('demo', 'Demo PLA')
  it('leaves nil keys out and lists them', () => {
    expect(r.section).toBe('filament')
    expect(r.nilKeys).toContain('filament_retraction_length')
    expect('filament_retraction_length' in r.config).toBe(false)
    expect(r.config['nozzle_temperature']).toEqual([220, 220])
  })
})

describe('every fixture profile', () => {
  it('imports without unknown or invalid keys', () => {
    const names = allProfileNames()
    expect(names.length).toBe(14)
    for (const [vendor, name] of names) {
      const r = loadProfile(vendor, name)
      expect(r.unknownKeys, `${vendor}/${name}`).toEqual([])
      expect(r.invalidKeys, `${vendor}/${name}`).toEqual([])
    }
  })
})

describe('errors and legacy keys', () => {
  it('rejects a cycle', () => {
    const a = { name: 'a', inherits: 'b' }
    const b = { name: 'b', inherits: 'a' }
    expect(() => importOrcaProfile(a, (n) => (n === 'b' ? b : a))).toThrow(ProfileError)
  })
  it('rejects a missing parent with its name', () => {
    expect(() => importOrcaProfile({ name: 'x', inherits: 'nope' }, () => undefined)).toThrow(/nope/)
  })
  it('rejects non-objects', () => {
    expect(() => importOrcaProfile([], () => undefined)).toThrow(ProfileError)
    expect(() => importOrcaProfile('x', () => undefined)).toThrow(ProfileError)
  })
  it('renames legacy keys and maps legacy values', () => {
    const r = importOrcaProfile({ name: 'old', type: 'process', enable_wipe_tower: '1', support_type: 'tree', wall_infill_order: 'outer wall/inner wall/infill' }, () => undefined)
    expect(r.config['enable_prime_tower']).toBe(true)
    expect(r.config['support_type']).toBe('tree(manual)')
    expect(r.config['wall_sequence']).toBe('outer wall/inner wall')
    expect(r.unknownKeys).toEqual([])
  })
  it('reports unknown keys and bad values instead of guessing', () => {
    const r = importOrcaProfile({ name: 'p', type: 'process', made_up_key: '1', layer_height: 'thick', wall_loops: '3' }, () => undefined)
    expect(r.unknownKeys).toEqual(['made_up_key'])
    expect(r.invalidKeys).toEqual(['layer_height'])
    expect(r.config['wall_loops']).toBe(3)
  })
  it('reads comma strings, percents and a scalar stored as a one entry list', () => {
    const r = importOrcaProfile({ name: 'p', type: 'machine', machine_min_travel_rate: '0,0', sparse_infill_density: '25%', layer_height: ['0.16'] }, () => undefined)
    expect(r.config['machine_min_travel_rate']).toEqual([0, 0])
    expect(r.config['sparse_infill_density']).toBe(25)
    expect(r.config['layer_height']).toBe(0.16)
  })
})

describe('export', () => {
  it('round-trips a process profile through Orca strings', () => {
    const r = loadProfile('demo', '0.20mm Standard @Demo')
    const json = exportOrcaProfile(r.config, { name: 'copy', section: 'process', inherits: r.chain[0] as string })
    expect(json['layer_height']).toBe('0.2')
    expect(json['sparse_infill_density']).toBe('15%')
    expect(json['enable_support']).toBe('0')
    const again = importOrcaProfile(json, vendorResolver('demo'))
    expect(again.unknownKeys).toEqual([])
    for (const [k, v] of Object.entries(r.config)) if (k in again.config) expect(again.config[k], k).toEqual(v)
  })
})

describe('Easy mode on a real profile', () => {
  it('turns a merged X1C setup into the concept defaults', () => {
    const cfg = mergeConfigs(loadProfile('demo', 'Demo Printer 0.4 nozzle').config, loadProfile('demo', 'Demo PLA').config, loadProfile('demo', '0.20mm Standard @Demo').config)
    const out = applyEasy(EASY_DEFAULTS, cfg)
    expect(out['layer_height']).toBe(0.2)
    expect(out['wall_loops']).toBe(2)
    expect(out['sparse_infill_density']).toBe(15)
    expect(out['top_shell_layers']).toBe(5)
    expect(out['bottom_shell_layers']).toBe(3)
    expect(out['brim_type']).toBe('auto_brim')
    expect(cfg['layer_height']).toBe(0.2)
  })
})
