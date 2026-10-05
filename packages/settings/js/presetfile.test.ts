// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Real preset bundles: fixtures/preset-files holds bundles written from OrcaSlicer 2.4.2's and Bambu Studio 2.8.2's
// default profiles in the apps' export format (scripts/make-preset-bundles.py), and a PrusaSlicer 2.9.6 project.
import { describe, expect, it } from 'vitest'
import { BundleError, importPresetFiles, presetKind, readPresetBundle } from './presetfile'
import { importPrusaIni, prusaProjectSettings, readPrusaConfig } from './prusa'
import { buildReport, countDefaulted, reportText, settingLabel } from './report'
import { presetFixture, unzipForTest } from './testkit'

const enc = new TextEncoder()
const entries = (files: Record<string, string | Uint8Array>) => new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]))
const bundle = (name: string) => readPresetBundle(unzipForTest(presetFixture(name)))

describe('preset bundles', () => {
  it('reads an OrcaSlicer printer bundle with its filament and process presets', async () => {
    const b = bundle('orca-2.4.2-printer.orca_printer')
    expect(b.type).toBe('printer')
    expect(b.printer).toBe('My A1 0.4 nozzle')
    expect(b.files.map((f) => [f.kind, f.json['name']])).toEqual([
      ['printer', 'My A1 0.4 nozzle'],
      ['filament', 'My PLA Basic @BBL A1'],
      ['process', 'My 0.20mm Standard @BBL A1'],
    ])
    const presets = await importPresetFiles(b.files, { printer: b.printer! })
    const process = presets.find((p) => p.kind === 'process')!
    // Its own values over the maker's 0.20mm Standard for the A1, which SlicerX ships.
    expect(process.values).toMatchObject({ wall_loops: 3, sparse_infill_density: 20, sparse_infill_pattern: 'gyroid', seam_position: 'back' })
    expect(process.values['outer_wall_speed']).toBeDefined()
    expect(process.inherits).toBe('0.20mm Standard @BBL A1')
    expect(process.printer).toBe('My A1 0.4 nozzle')
    expect(process.report.parent).toEqual({ name: '0.20mm Standard @BBL A1', found: true })
    expect(process.report.items).toEqual([])
    expect(process.report.defaulted).toBe(0)
    const filament = presets.find((p) => p.kind === 'filament')!
    expect(filament.values).toMatchObject({ nozzle_temperature: [215], filament_flow_ratio: [0.97], pressure_advance: [0.025] })
    expect(filament.report.parent?.found).toBe(true)
    const printer = presets.find((p) => p.kind === 'printer')!
    expect(printer.values).toMatchObject({ retraction_length: [0.9], z_hop: [0.6] })
    expect(printer.printer).toBeUndefined()
  })

  it('reads an OrcaSlicer filament bundle', async () => {
    const b = bundle('orca-2.4.2-filament.orca_filament')
    expect(b.type).toBe('filament')
    expect(b.files.map((f) => f.path)).toEqual(['BBL/My PLA Basic @BBL A1.json'])
    const [p] = await importPresetFiles(b.files)
    expect(p!.kind).toBe('filament')
    expect(p!.values['nozzle_temperature']).toEqual([215])
  })

  it('reports what a Bambu Studio printer bundle could not bring', async () => {
    const b = bundle('bambu-studio-2.8.2-printer.bbscfg')
    expect(b.type).toBe('printer')
    expect(b.printer).toBe('My A1 mini 0.4 nozzle')
    const presets = await importPresetFiles(b.files, { printer: b.printer! })
    expect(presets.map((p) => p.name)).toEqual(['My A1 mini 0.4 nozzle', 'My PLA Basic @BBL A1M', 'Matte Works PLA @My A1 mini 0.4 nozzle', 'Matte Works PLA Tuned', 'My 0.20mm Standard @BBL A1M'])
    const process = presets.find((p) => p.kind === 'process')!
    // 2D lattice is Bambu Studio's; the import uses Orca's lateral lattice and says so.
    expect(process.values['sparse_infill_pattern']).toBe('lateral-lattice')
    const byKey = Object.fromEntries(process.report.items.map((i) => [i.key, i]))
    expect(Object.keys(byKey).sort()).toEqual(['enable_height_slowdown', 'sparse_infill_pattern', 'top_one_wall_type'])
    expect(byKey['sparse_infill_pattern']).toMatchObject({ label: 'Infill pattern', oldValue: '2dlattice', reason: 'invalid', instead: { value: 'Lateral lattice', nearest: true } })
    expect(byKey['top_one_wall_type']).toMatchObject({ label: 'Only one wall on top surfaces', reason: 'unsupported', instead: { key: 'only_one_wall_top', label: 'Single wall on the top surface', nearest: true } })
    expect(byKey['enable_height_slowdown']).toMatchObject({ label: 'Slow down by height', oldValue: '1', reason: 'unsupported', instead: null })
    const filament = presets.find((p) => p.name === 'My PLA Basic @BBL A1M')!
    expect(filament.report.items.map((i) => [i.key, i.reason, i.instead?.key ?? null])).toEqual([
      ['circle_compensation_speed', 'unsupported', null],
      ['filament_scarf_seam_type', 'unsupported', 'seam_slope_type'],
    ])
    // A filament made with Create filament has no parent; the one made from it finds it in the bundle.
    const root = presets.find((p) => p.name === 'Matte Works PLA @My A1 mini 0.4 nozzle')!
    expect(root.report.parent).toBeUndefined()
    expect(root.printer).toBe('My A1 mini 0.4 nozzle')
    // A Bambu-only key the base set to `nil` held nothing, so it is not listed.
    expect(root.report.items.some((i) => i.key === 'filament_long_retractions_when_ec')).toBe(false)
    expect(root.report.items.length).toBeGreaterThan(20)
    const tuned = presets.find((p) => p.name === 'Matte Works PLA Tuned')!
    expect(tuned.report.parent).toEqual({ name: 'Matte Works PLA @My A1 mini 0.4 nozzle', found: true, bundled: true })
    expect(tuned.values['filament_flow_ratio']).toEqual([0.95])
    expect(tuned.values['nozzle_temperature']).toEqual(root.values['nozzle_temperature'])
    expect(tuned.values['filament_vendor']).toEqual(['Matte Works'])
  })

  it('reads a Bambu Studio filament bundle, grouped by filament vendor', async () => {
    const b = bundle('bambu-studio-2.8.2-filament.bbsflmt')
    expect(b.type).toBe('filament')
    expect(b.files.map((f) => f.path)).toEqual(['Matte Works/Matte Works PLA @My A1 mini 0.4 nozzle.json', 'Matte Works/Matte Works PLA Tuned.json'])
    const presets = await importPresetFiles(b.files)
    expect(presets.find((p) => p.name === 'Matte Works PLA Tuned')!.report.parent?.found).toBe(true)
  })

  it('tells the kind of a user preset by its settings id', () => {
    expect(presetKind({ print_settings_id: 'x' })).toBe('process')
    expect(presetKind({ filament_settings_id: ['x'] })).toBe('filament')
    expect(presetKind({ printer_settings_id: 'x' })).toBe('printer')
    expect(presetKind({ type: 'machine' })).toBe('printer')
    expect(presetKind({ name: 'x' })).toBeUndefined()
  })

  it('keeps own values of a preset whose parent SlicerX does not have, and counts the rest as defaults', async () => {
    const [p] = await importPresetFiles([{ path: 'x.json', kind: 'process', json: { name: 'Mine', inherits: '0.20mm Standard @Nobody 9000', print_settings_id: 'Mine', wall_loops: '4' } }])
    expect(p!.values).toEqual({ wall_loops: 4 })
    expect(p!.report.parent).toEqual({ name: '0.20mm Standard @Nobody 9000', found: false })
    expect(p!.report.defaulted).toBeGreaterThan(100)
  })
})

describe('untrusted bundles', () => {
  const printerBundle = (files: string[], extra: Record<string, string | Uint8Array> = {}) =>
    entries({ 'bundle_structure.json': JSON.stringify({ bundle_type: 'printer config bundle', printer_preset_name: 'P', printer_config: files, filament_config: [], process_config: [] }), ...extra })

  it('skips paths that climb out, and entries it does not have', () => {
    const b = readPresetBundle(printerBundle(['../evil.json', 'printer/missing.json', 'printer/P.json'], { 'printer/P.json': '{"name":"P","printer_settings_id":"P"}' }))
    expect(b.files.map((f) => f.path)).toEqual(['printer/P.json'])
    expect(b.skipped.map((s) => s.path)).toEqual(['../evil.json', 'printer/missing.json'])
    expect(b.skipped[0]!.why).toMatch(/not safe/)
  })

  it('skips oversized entries and files of another kind', () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(32)
    const b = readPresetBundle(printerBundle(['printer/big.json', 'printer/f.json', 'printer/P.json'], { 'printer/big.json': big, 'printer/f.json': '{"name":"F","filament_settings_id":["F"]}', 'printer/P.json': '{"name":"P","printer_settings_id":"P"}' }))
    expect(b.skipped.map((s) => s.why)).toEqual(['The file is too large to be a preset.', 'The file is a different kind of preset than the bundle says.'])
  })

  it('refuses a bundle with nothing to import, a damaged description and too many presets', () => {
    expect(() => readPresetBundle(entries({ 'readme.txt': 'hi' }))).toThrow(BundleError)
    expect(() => readPresetBundle(entries({ 'bundle_structure.json': '{nope' }))).toThrow(/damaged/)
    const many: Record<string, string> = {}
    for (let i = 0; i < 501; i++) many[`process/p${i}.json`] = `{"name":"p${i}","print_settings_id":"p${i}"}`
    expect(() => readPresetBundle(entries(many))).toThrow(/too many/)
  })

  it('reads a plain zip of preset files by folder or by content', () => {
    const b = readPresetBundle(entries({ 'process/a.json': '{"name":"A","wall_loops":"3"}', 'b.json': '{"name":"B","filament_settings_id":["B"]}', 'c.txt': 'x' }))
    expect(b.type).toBe('presets')
    expect(b.files.map((f) => [f.path, f.kind])).toEqual([['b.json', 'filament'], ['process/a.json', 'process']])
  })
})

describe('PrusaSlicer', () => {
  it('reads the settings of a PrusaSlicer 2.9.6 project', () => {
    const files = unzipForTest(presetFixture('prusaslicer-2.9.6.3mf'))
    const text = new TextDecoder().decode(files.get('Metadata/Slic3r_PE.config')!)
    expect(readPrusaConfig(text)['perimeters']).toBe('3')
    const { values, unmapped } = prusaProjectSettings(text)
    expect(values).toMatchObject({ wall_loops: '3', sparse_infill_density: '20%', nozzle_temperature: '240', enable_support: '1', support_type: 'tree(auto)' })
    expect(unmapped).toContain('fan_always_on')
  })

  it('reports PrusaSlicer keys with the nearest SlicerX setting', () => {
    const [f] = importPrusaIni('[filament:My PETG]\ntemperature = 240\nfan_always_on = 1\nfilament_spool_weight = 230\n', 'b.ini')
    const r = buildReport({ name: f!.name, section: f!.section, family: 'prusa', dropped: f!.dropped, config: f!.config, origin: {}, defaulted: countDefaulted(f!.section, f!.config) })
    expect(r.items.map((i) => [i.label, i.instead?.label ?? null])).toEqual([
      ['Filament spool weight', null],
      ['Keep fan always on', 'Avoid stopping the fan between layers'],
    ])
    expect(r.defaulted).toBeGreaterThan(0)
  })
})

describe('report text', () => {
  it('uses labels, never keys, unless asked', async () => {
    const presets = await importPresetFiles(bundle('bambu-studio-2.8.2-printer.bbscfg').files, { printer: 'My A1 mini 0.4 nozzle' })
    const reports = presets.map((p) => p.report)
    const text = reportText(reports)
    expect(text).toContain('Infill pattern: 2dlattice. SlicerX cannot use this value. Uses Lateral lattice, the nearest value SlicerX has.')
    expect(text).not.toContain('top_one_wall_type')
    expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`))
    expect(reportText(reports, { keys: true })).toContain('[top_one_wall_type]')
  })

  it('makes words of a key outside the schema', () => {
    expect(settingLabel('circle_compensation_speed')).toBe('Circle compensation speed')
    expect(settingLabel('some_ams_gcode_thing')).toBe('Some AMS G-code thing')
    expect(settingLabel('wall_loops')).toBe('Wall loops')
  })
})
